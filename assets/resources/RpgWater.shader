Shader3D Start
{
    type:Shader3D,
    name:RpgWater,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    uniformMap:{
        u_ShallowColor: { type: Color, default: [0.25, 0.65, 0.72, 0.45] },
        u_DeepColor: { type: Color, default: [0.06, 0.26, 0.50, 0.88] },
        u_SkyColor: { type: Color, default: [0.72, 0.85, 0.95, 1.0] },
        u_SunDir: { type: Vector3, default: [-0.4, 0.8, 0.45] },
    },
    defines: {
    }
    shaderPass:[
        {
            pipeline:Forward,
            VS:waterVS,
            FS:waterPS
        }
    ]
}
Shader3D End

GLSL Start
#defineGLSL waterVS

    #define SHADER_NAME RpgWaterVS

    #include "Math.glsl";

    #include "Scene.glsl";
    #include "SceneFogInput.glsl";

    #include "Camera.glsl";
    #include "Sprite3DVertex.glsl";

    #include "VertexCommon.glsl";

    varying vec3 v_PositionWS;
    varying float v_Depth;

    void main()
    {
        Vertex vertex;
        getVertexParams(vertex);

        mat4 worldMat = getWorldMatrix();
        vec4 pos = (worldMat * vec4(vertex.positionOS, 1.0));
        vec3 positionWS = pos.xyz / pos.w;

    #ifdef COLOR
        // 顶点色 r = 水深 0~1（由 ChunkRenderer.buildWaterMesh 写入）
        // 引擎会把顶点色当作 gamma 空间做 pow(2.2)，这里还原成原始数值
        v_Depth = pow(vertex.vertexColor.r, 1.0 / 2.2);
    #else
        v_Depth = 1.0;
    #endif

        // 轻微起伏，岸边（深度 0）不动，避免和地形穿插
        float wave1 = sin(positionWS.x * 0.30 + u_Time * 1.1) * cos(positionWS.z * 0.25 + u_Time * 0.9);
        float wave2 = sin(positionWS.x * 0.18 + positionWS.z * 0.22 + u_Time * 0.7) * 0.5;
        positionWS.y += (wave1 + wave2) * 0.04 * smoothstep(0.0, 0.3, v_Depth);
        v_PositionWS = positionWS;

        gl_Position = getPositionCS(positionWS);
        gl_Position = remapPositionZ(gl_Position);

    #ifdef FOG
        FogHandle(gl_Position.z);
    #endif
    }
#endGLSL

#defineGLSL waterPS

    #define SHADER_NAME RpgWaterPS

    #include "Color.glsl";

    #include "Scene.glsl";
    #include "SceneFog.glsl";

    #include "Camera.glsl";
    #include "Sprite3DFrag.glsl";

    varying vec3 v_PositionWS;
    varying float v_Depth;

    // ---------- 噪声工具 ----------

    // 不用 sin 的哈希（Dave Hoskins hash12）：手机 GPU 上 sin 较贵，且世界坐标大时 sin 精度会崩
    float wHash(vec2 p)
    {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    float wNoise(vec2 p)
    {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
                   mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    // 扭曲噪声 —— 产生自然的焦散光纹（扭曲层只用一次噪声，两个方向错开）
    float causticNoise(vec2 p, float t)
    {
        // 第一层：慢速大尺度扭曲
        float q = wNoise(p + vec2(t * 0.12, t * 0.08));
        // 用第一层扭曲坐标做第二层
        return wNoise(p * 1.8 + vec2(q, 1.0 - q) * 1.5 + vec2(t * 0.15, t * 0.1));
    }

    // 方向波梯度（用来算法线）
    vec2 waveGrad(vec2 p, vec2 dir, float freq, float speed, float amp)
    {
        float ph = dot(p, dir) * freq + u_Time * speed;
        return dir * (cos(ph) * freq * amp);
    }

    void main()
    {
        vec2 p = v_PositionWS.xz;
        float depth = clamp(v_Depth, 0.0, 1.0);

        // ---------- 法线（多方向波叠加） ----------
        vec2 g = waveGrad(p, normalize(vec2(1.0, 0.3)),  0.50, 1.4, 0.08)
               + waveGrad(p, normalize(vec2(-0.4, 1.0)), 0.75, 1.7, 0.06)
               + waveGrad(p, normalize(vec2(0.7, -0.8)), 1.50, 2.4, 0.030)
               + waveGrad(p, normalize(vec2(-1.0, -0.2)),2.60, 3.0, 0.015);
        // 浅水区法线扰动减弱，让岸边更平静
        g *= smoothstep(0.0, 0.25, depth);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

        vec3 viewDir = normalize(u_CameraPos - v_PositionWS);

        // ---------- 基础水色 ----------
        // 使用更平滑的深度映射，避免跳变
        float depthFactor = smoothstep(0.0, 0.6, depth);
        vec3 base = mix(u_ShallowColor.rgb, u_DeepColor.rgb, depthFactor);

        // 水下焦散暗纹：给深水区增加一点斑驳的色彩变化
        // 焦散只在有一定深度时可见，浅水区（mask = 0）跳过噪声计算
        float causticMask = smoothstep(0.15, 0.5, depth) * 0.12;
        if (causticMask > 0.0)
            base += (causticNoise(p * 0.25, u_Time) - 0.5) * causticMask;

        // ---------- 菲涅尔天空反射（降低强度，更通透） ----------
        float NdotV = clamp(dot(n, viewDir), 0.0, 1.0);
        // pow(x, 3.5) 的近似：x^3 * sqrt(x)
        float fv = 1.0 - NdotV;
        float fresnel = fv * fv * fv * sqrt(fv);
        // 限制最大反射量，保留水的通透感
        vec3 col = mix(base, u_SkyColor.rgb, fresnel * 0.45 + 0.03);

        // ---------- 太阳高光（稍微收敛） ----------
        vec3 sun = normalize(u_SunDir);
        vec3 h = normalize(sun + viewDir);
        float spec = pow(max(dot(n, h), 0.0), 220.0) * 1.2;
        col += vec3(1.0, 0.97, 0.90) * spec;

        // ---------- 岸边泡沫（多层柔和） ----------
        // 泡沫带最宽 (0.08 + 0.04) * 1.2 = 0.144，更深的地方没有泡沫，跳过噪声计算
        float foam = 0.0;
        if (depth < 0.15) {
            // 两个不同频率的噪声叠加，产生自然碎浪
            float nz1 = wNoise(p * 0.7 + vec2(u_Time * 0.18, u_Time * 0.12));
            float nz2 = wNoise(p * 1.5 + vec2(-u_Time * 0.14, u_Time * 0.22));
            float nzBlend = nz1 * 0.6 + nz2 * 0.4;

            // 泡沫带宽度随时间脉动
            float band = 0.08 + 0.04 * sin(u_Time * 1.2 + nzBlend * 6.2831);
            // 泡沫随深度淡出，使用更宽的 smoothstep 过渡
            float foamEdge = (1.0 - smoothstep(band * 0.3, band * 1.2, depth));
            // 噪声裁切，让泡沫呈碎片状而不是实心白带
            float foamNoise = smoothstep(0.32, 0.55, nzBlend);
            foam = foamEdge * foamNoise;
            // 极浅水区（depth ≈ 0）保留一层薄泡沫
            foam = max(foam, (1.0 - smoothstep(0.0, 0.06, depth)) * 0.6);
            // 泡沫颜色带一点水色，不要纯白
            vec3 foamColor = mix(vec3(0.88, 0.94, 0.97), vec3(0.95, 0.97, 1.0), nzBlend);
            col = mix(col, foamColor, foam * 0.65);
        }

        // ---------- 透明度 ----------
        float alpha = mix(u_ShallowColor.a, u_DeepColor.a, smoothstep(0.0, 0.7, depth));
        // 泡沫区域稍微不透明
        alpha = max(alpha, foam * 0.7);
        // 高光区域不透明
        alpha = clamp(alpha + spec * 0.8, 0.0, 1.0);

    #ifdef FOG
        col = scenUnlitFog(col);
    #endif

        gl_FragColor = vec4(col, alpha);
        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL
GLSL End
