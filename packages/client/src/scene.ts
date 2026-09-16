import {
  ArcRotateCamera,
  Color3,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

/**
 * The camera angle is fixed for the whole game (Pony Town style): players
 * never rotate or tilt the view. ArcRotateCamera is used only because it's
 * the simplest way to point a camera at a target from a set angle/distance —
 * its orbit controls are intentionally never attached to the canvas.
 */
const FIXED_ALPHA = -Math.PI / 2;
const FIXED_BETA = Math.PI / 3.6;
const FIXED_RADIUS = 45;

export function createScene(engine: Engine, canvas: HTMLCanvasElement): Scene {
  const scene = new Scene(engine);
  scene.clearColor.set(0.1, 0.11, 0.13, 1);

  const camera = new ArcRotateCamera(
    "mainCamera",
    FIXED_ALPHA,
    FIXED_BETA,
    FIXED_RADIUS,
    Vector3.Zero(),
    scene
  );
  camera.inputs.clear();

  const light = new HemisphericLight("mainLight", new Vector3(0, 1, 0), scene);
  light.intensity = 0.9;

  const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40 }, scene);
  ground.material = createGroundMaterial(scene);

  window.addEventListener("resize", () => {
    engine.resize();
  });

  return scene;
}

function createGroundMaterial(scene: Scene) {
  const material = new StandardMaterial("groundMaterial", scene);
  material.diffuseColor = new Color3(0.2, 0.45, 0.25);
  return material;
}
