Shader3D Start
{
    type:Shader3D,
    name:RpgWater,
    enableInstancing:false,
    shaderType:D3,
    supportReflectionProbe:false,
    uniformMap:{
        u_ShallowColor: { type: Color, default: [0.28, 0.72, 0.78, 0.55] },
        u_DeepColor: { type: Color, default: [0.07, 0.30, 0.55, 0.92] },
        u_SkyColor: { type: Color, default: [0.70, 0.84, 0.96, 1.0] },
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
        positionWS.y += sin(positionWS.x * 0.35 + u_Time * 1.3) * cos(positionWS.z * 0.29 + u_Time * 1.1) * 0.06 * v_Depth;
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

    float wHash(vec2 p)
    {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float wNoise(vec2 p)
    {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
                   mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    // 一组方向波的高度梯度（只需要梯度来求法线）
    vec2 waveGrad(vec2 p, vec2 dir, float freq, float speed, float amp)
    {
        float ph = dot(p, dir) * freq + u_Time * speed;
        return dir * (cos(ph) * freq * amp);
    }

    void main()
    {
        vec2 p = v_PositionWS.xz;
        vec2 g = waveGrad(p, normalize(vec2(1.0, 0.3)), 0.55, 1.6, 0.10)
               + waveGrad(p, normalize(vec2(-0.4, 1.0)), 0.83, 1.9, 0.07)
               + waveGrad(p, normalize(vec2(0.7, -0.8)), 1.70, 2.7, 0.035)
               + waveGrad(p, normalize(vec2(-1.0, -0.2)), 2.90, 3.4, 0.018);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));

        vec3 viewDir = normalize(u_CameraPos - v_PositionWS);
        float depth = clamp(v_Depth, 0.0, 1.0);

        // 深浅水颜色 + 菲涅尔天空反射
        vec3 base = mix(u_ShallowColor.rgb, u_DeepColor.rgb, smoothstep(0.0, 1.0, depth));
        float fresnel = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 4.0);
        vec3 col = mix(base, u_SkyColor.rgb, clamp(fresnel * 0.8 + 0.05, 0.0, 1.0));

        // 太阳高光
        vec3 sun = normalize(u_SunDir);
        vec3 h = normalize(sun + viewDir);
        float spec = pow(max(dot(n, h), 0.0), 180.0) * 1.6;
        col += vec3(1.0, 0.97, 0.88) * spec;

        // 岸边泡沫：浅水处随时间涌动的白边
        float nz = wNoise(p * 0.9 + vec2(u_Time * 0.25, u_Time * 0.18));
        float band = 0.06 + 0.035 * sin(u_Time * 1.5 + nz * 6.2831);
        float foam = (1.0 - smoothstep(band * 0.4, band, depth)) * step(0.35, nz + 0.25);
        foam = max(foam, 1.0 - smoothstep(0.0, 0.04, depth));
        col = mix(col, vec3(0.95, 0.98, 1.0), foam * 0.85);

        float alpha = mix(u_ShallowColor.a, u_DeepColor.a, smoothstep(0.0, 0.8, depth));
        alpha = max(alpha, foam * 0.9);
        alpha = clamp(alpha + spec, 0.0, 1.0);

    #ifdef FOG
        col = scenUnlitFog(col);
    #endif

        gl_FragColor = vec4(col, alpha);
        gl_FragColor = outputTransform(gl_FragColor);
    }
#endGLSL
GLSL End
