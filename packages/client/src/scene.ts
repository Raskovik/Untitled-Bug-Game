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

/** Flat solid ground color — no gradient, no lighting shading. */
const GROUND_COLOR = new Color3(0.2, 0.45, 0.25);

export interface GameScene {
  scene: Scene;
  camera: ArcRotateCamera;
  ground: Mesh;
  setOrthoSize: (size: number) => void;
}

export function createScene(engine: Engine, canvas: HTMLCanvasElement): GameScene {
  const scene = new Scene(engine);
  scene.clearColor.set(GROUND_COLOR.r, GROUND_COLOR.g, GROUND_COLOR.b, 1);

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

  let orthoSize = ORTHO_SIZE;
  const updateOrthoBounds = () => {
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    camera.orthoTop = orthoSize;
    camera.orthoBottom = -orthoSize;
    camera.orthoLeft = -orthoSize * aspect;
    camera.orthoRight = orthoSize * aspect;
  };
  updateOrthoBounds();

  const setOrthoSize = (size: number) => {
    orthoSize = size;
    updateOrthoBounds();
  };

  const light = new HemisphericLight("mainLight", new Vector3(0, 1, 0), scene);
  light.intensity = 0.9;

  const ground = MeshBuilder.CreateGround("ground", { width: 400, height: 400 }, scene);
  ground.material = createGroundMaterial(scene);

  window.addEventListener("resize", () => {
    engine.resize();
    updateOrthoBounds();
  });

  return { scene, camera, ground, setOrthoSize };
}

function createGroundMaterial(scene: Scene) {
  const material = new StandardMaterial("groundMaterial", scene);
  // Unlit/emissive so the ground is a perfectly flat solid color with no
  // lighting-based shading variation across its surface.
  material.disableLighting = true;
  material.emissiveColor = GROUND_COLOR;
  return material;
}
