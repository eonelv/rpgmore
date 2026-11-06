# 进度记录

## 已完成（代码在 src/）
- 程序化无限世界：块 64m（32 格 × 2m），5x5 流式加载，雾遮边界
- 寻路：分层 + 分帧 A*，长距离分段（每段 3 块）
- 砍树：点击树/按 F，修改记录在 NavGrid.edits（只在内存，刷新丢失）
- 怪物：按块确定性生成野外随机怪 0~2 只，闲逛/追击
- 世界是确定性的（SEED 固定）

## 2026-11-05 方案 A + 小地图（已实现，tsc 通过，未在 IDE/浏览器实测）
- src/world/UnitDefs.ts：怪物种类表（imp/wolf/slime/ghost），加新种类只改这里
- src/world/Spawns.ts：SpawnInfo、spawnPosition（编辑器和运行时共用，位置一致）、SpawnRegistry（按块索引）
- src/editor/WorldPreview.ts：@runInEditor，在 IDE 场景视图里画地形（中心块+半径），节点 HideAndDontSave
- src/editor/SpawnPoint.ts：@runInEditor 刷怪点组件，属性=种类/数量/半径/清除随机怪，编辑器画范围圈和出生位置
- src/ui/Minimap.ts：右上角小地图，每块 32x32 贴图缓存，砍树时 invalidate，M 键切换大地图（1.6km），每帧最多建 12 块贴图
- Main.ts：启动时递归收集 SpawnPoint；HUD 显示刷怪点数
- MonsterManager：怪物按出生块回收（originKey），修复了块重载时重复生成的问题
- Scene.ls 加了 WorldPreview 节点和 Spawns/wolf_den(90,40)、slime_pond(20,110)；备份 assets/Scene.ls.bak
- 注意：本机 python 是应用商店占位程序，脚本改文件要用 node

## 2026-11-05 文档（已完成）
- docs/世界内容方案.md：问题、方案 A/B/C 对比、关键设计、实现清单、已知限制、后续计划
- docs/关卡编辑指南.md：预览地形、摆放刷怪点、加怪物种类、小地图、常见问题

## 2026-11-06 水面 shader（tsc 通过，未在浏览器实测）
- assets/resources/RpgWater.shader：水面 shader 资源文件（代码注册会被 IDE 的 Shader3D.find 钩子绕过，必须用 .shader 资源）。src/world/WaterShader.ts 只建材质；Main.onStart 先 await loadWaterShader() 再建世界
- 水面效果：，波纹法线、菲涅尔天空反射、太阳高光、岸边泡沫、雾；时间用引擎的 u_Time
- ChunkRenderer.buildWaterMesh(cx,cz)：每块只给有水的格子建网格（世界坐标），顶点色 r = 水深 0~1；无水返回 null
- ChunkManager/WorldPreview 改用每块水网格，卸载时销毁
- 颜色参数在 createWaterMaterial 里调（浅水/深水/天空/太阳方向）

## 保留未做
- 方案 B：游戏内编辑模式导出 JSON
- 方案 C：导出世界俯视 PNG（可复用 Minimap 的贴图逻辑）
- 战斗（HP/攻击）、事件总线、任务系统、特效 FxManager、砍树存档

## 待用户验证
- 在 LayaAir IDE 打开 Scene.ls，确认地形预览和刷怪点 gizmo 显示正常
