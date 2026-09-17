import {
  ArcRotateCamera,
  Camera,
  Color3,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

/**
 * The camera angle is fixed for the whole game (Animal Jam Classic style):
 * players never rotate or tilt the view. ArcRotateCamera is used only
 * because it's the simplest way to point a camera at a target from a set
 * angle/distance — its orbit controls are intentionally never attached to
 * the canvas.
 *
 * The camera is orthographic, not perspective: a character standing "further
 * back" on the map must render at the same size as one standing close, never
 * shrinking with distance the way a real camera/photo would.
 */
const FIXED_ALPHA = -Math.PI / 2;
const FIXED_BETA = Math.PI / 3.6;
const FIXED_RADIUS = 45;

/** Half the height of the visible area, in world units — controls zoom level. */
const ORTHO_SIZE = 12;

const SKY_COLOR = new Color3(0.53, 0.72, 0.85);

export interface GameScene {
  scene: Scene;
  camera: ArcRotateCamera;
  ground: Mesh;
}

export function createScene(engine: Engine, canvas: HTMLCanvasElement): GameScene {
  const scene = new Scene(engine);
  scene.clearColor.set(SKY_COLOR.r, SKY_COLOR.g, SKY_COLOR.b, 1);

  // Fog fades the ground into the sky color before its edges ever reach the
  // camera's view, so the world reads as continuous terrain instead of a
  // floating plane with visible boundaries.
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = SKY_COLOR;
  scene.fogDensity = 0.012;

  const camera = new ArcRotateCamera(
    "mainCamera",
    FIXED_ALPHA,
    FIXED_BETA,
    FIXED_RADIUS,
    Vector3.Zero(),
    scene
  );
  camera.inputs.clear();
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;

  const updateOrthoBounds = () => {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    camera.orthoTop = ORTHO_SIZE;
    camera.orthoBottom = -ORTHO_SIZE;
    camera.orthoLeft = -ORTHO_SIZE * aspect;
    camera.orthoRight = ORTHO_SIZE * aspect;
  };
  updateOrthoBounds();

  const light = new HemisphericLight("mainLight", new Vector3(0, 1, 0), scene);
  light.intensity = 0.9;

  const ground = MeshBuilder.CreateGround("ground", { width: 400, height: 400 }, scene);
  ground.material = createGroundMaterial(scene);

  window.addEventListener("resize", () => {
    engine.resize();
    updateOrthoBounds();
  });

  return { scene, camera, ground };
}

function createGroundMaterial(scene: Scene) {
  const material = new StandardMaterial("groundMaterial", scene);
  material.diffuseColor = new Color3(0.2, 0.45, 0.25);
  return material;
}
