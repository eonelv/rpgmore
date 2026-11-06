{
  "_$ver": 1,
  "_$id": "er2lfkwr",
  "_$type": "Scene",
  "name": "Scene2D",
  "left": 0,
  "right": 0,
  "top": 0,
  "bottom": 0,
  "_$child": [
    {
      "_$id": "n9gjxcltvl",
      "_$type": "Scene3D",
      "name": "Scene3D",
      "ambientMode": 0,
      "ambientColor": {
        "_$type": "Color",
        "r": 0.424308,
        "g": 0.4578516,
        "b": 0.5294118
      },
      "skyRenderer": {
        "meshType": "dome",
        "material": {
          "_$uuid": "793cffc6-730a-4756-a658-efe98c230292",
          "_$type": "Material"
        }
      },
      "fogStart": 0,
      "fogRange": 300,
      "fogColor": {
        "_$type": "Color",
        "r": 0.5,
        "g": 0.5,
        "b": 0.5
      },
      "lightmaps": [],
      "_$child": [
        {
          "_$id": "6jx8h8bvc6",
          "_$type": "Camera",
          "name": "Main Camera",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "y": 1,
              "z": 5
            }
          },
          "clearFlag": 1,
          "clearColor": {
            "_$type": "Color",
            "r": 0.3921,
            "g": 0.5843,
            "b": 0.9294
          },
          "orthographicVerticalSize": 10,
          "fieldOfView": 60,
          "nearPlane": 0.3,
          "farPlane": 1000,
          "normalizedViewport": {
            "_$type": "Viewport",
            "width": 1,
            "height": 1
          }
        },
        {
          "_$id": "6ni3p096l5",
          "_$type": "Sprite3D",
          "name": "Direction Light",
          "transform": {
            "localPosition": {
              "_$type": "Vector3",
              "x": 5,
              "y": 5,
              "z": 5
            },
            "localRotationEuler": {
              "_$type": "Vector3",
              "x": -50,
              "y": 30
            }
          },
          "_$comp": [
            {
              "_$type": "DirectionLightCom",
              "color": {
                "_$type": "Color",
                "r": 0.6,
                "g": 0.6,
                "b": 0.6
              },
              "lightmapBakedType": 1,
              "shadowMode": 0,
              "shadowStrength": 1,
              "shadowDistance": 50,
              "shadowDepthBias": 1,
              "shadowNormalBias": 1,
              "shadowNearPlane": 0.1,
              "shadowCascadesMode": 0
            }
          ]
        },
        {
          "_$id": "223a9bdb6e",
          "_$type": "Sprite3D",
          "name": "WorldPreview",
          "_$comp": [
            {
              "_$type": "701bacfd-99ac-4a70-a0a0-9fc8ebde2054",
              "scriptPath": "../src/editor/WorldPreview.ts",
              "centerChunkX": 0,
              "centerChunkZ": 0,
              "radius": 3
            }
          ]
        },
        {
          "_$id": "623abd5a66",
          "_$type": "Sprite3D",
          "name": "Spawns",
          "_$child": [
            {
              "_$id": "239d0d735f",
              "_$type": "Sprite3D",
              "name": "wolf_den",
              "transform": {
                "localPosition": {
                  "_$type": "Vector3",
                  "x": 90,
                  "y": 0,
                  "z": 40
                }
              },
              "_$comp": [
                {
                  "_$type": "cbe41eb3-2e76-4b98-9959-1944b4f401a4",
                  "scriptPath": "../src/editor/SpawnPoint.ts",
                  "kind": "wolf",
                  "count": 4,
                  "radius": 10,
                  "clearRandom": true
                }
              ]
            },
            {
              "_$id": "3167b0409e",
              "_$type": "Sprite3D",
              "name": "slime_pond",
              "transform": {
                "localPosition": {
                  "_$type": "Vector3",
                  "x": 20,
                  "y": 0,
                  "z": 110
                }
              },
              "_$comp": [
                {
                  "_$type": "cbe41eb3-2e76-4b98-9959-1944b4f401a4",
                  "scriptPath": "../src/editor/SpawnPoint.ts",
                  "kind": "slime",
                  "count": 5,
                  "radius": 8,
                  "clearRandom": true
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "_$comp": [
    {
      "_$type": "7bad1742-6eed-4d8d-81c0-501dc5bf03d6",
      "scriptPath": "../src/Main.ts"
    }
  ]
}