// The pixel-art spellbook. Runs in a worker with an OffscreenCanvas: it draws,
// and that is all. It receives sizes, a state name and "something was typed"
// ticks. Its response headers remove network access entirely.
import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  OrthographicCamera,
  Points,
  PointsMaterial,
  RedFormat,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";

// "opened" is a read that leaves opens on the link; "revealed" is the last one, so the writing burns.
export type SceneState = "idle" | "writing" | "sealing" | "sealed" | "locked" | "opened" | "revealed" | "gone";
export type SceneMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number; reduced: boolean }
  | { type: "resize"; width: number; height: number }
  | { type: "state"; name: SceneState }
  | { type: "pointer"; x: number; y: number }
  | { type: "visible"; on: boolean }
  | { type: "pulse" }
  | { type: "shake" };

// ---- palette ---------------------------------------------------------------
const C = {
  leather: 0x7a2f3c,
  leatherDark: 0x4a1a26,
  leatherLight: 0x9a4350,
  gold: 0xe8b44c,
  goldDark: 0xa8742a,
  parchment: 0xecd9a8,
  parchmentDark: 0xcfb57a,
  ink: 0x3a2618,
  red: 0xb23a32,
  ember: 0xf0702c,
  gem: 0x58d8c8,
  ash: 0x4a4652,
};

// ---- tiny pixel-art canvas backed by a DataTexture ---------------------------
class Pixels {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly texture: DataTexture;
  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint8Array(w * h * 4);
    this.texture = new DataTexture(this.data, w, h);
    this.texture.magFilter = this.texture.minFilter = NearestFilter;
    this.texture.colorSpace = SRGBColorSpace;
  }
  // y = 0 is the top row
  rect(x: number, y: number, w: number, h: number, color: number) {
    for (let py = Math.max(0, y); py < Math.min(this.h, y + h); py++) {
      for (let px = Math.max(0, x); px < Math.min(this.w, x + w); px++) {
        const i = ((this.h - 1 - py) * this.w + px) * 4;
        this.data[i] = color >> 16;
        this.data[i + 1] = (color >> 8) & 255;
        this.data[i + 2] = color & 255;
        this.data[i + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
  }
}

function random(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function coverArt(front: boolean): DataTexture {
  const art = new Pixels(24, 32);
  const rand = random(front ? 7 : 11);
  art.rect(0, 0, 24, 32, C.leather);
  for (let i = 0; i < 46; i++) art.rect(Math.floor(rand() * 24), Math.floor(rand() * 32), 1, 1, rand() > 0.5 ? C.leatherDark : C.leatherLight);
  // gold frame with corner studs
  art.rect(2, 2, 20, 1, C.gold);
  art.rect(2, 29, 20, 1, C.goldDark);
  art.rect(2, 2, 1, 28, C.gold);
  art.rect(21, 2, 1, 28, C.goldDark);
  for (const [x, y] of [[1, 1], [20, 1], [1, 28], [20, 28]] as const) art.rect(x, y, 3, 3, C.gold);
  if (front) {
    // keyhole emblem
    art.rect(9, 9, 6, 6, C.gold);
    art.rect(10, 8, 4, 8, C.gold);
    art.rect(11, 15, 2, 7, C.gold);
    art.rect(10, 20, 4, 3, C.gold);
    art.rect(11, 10, 2, 3, C.leatherDark);
    art.rect(11, 13, 2, 5, C.leatherDark);
    art.rect(10, 11, 4, 2, C.leatherDark);
  } else {
    for (let i = 0; i < 5; i++) art.rect(11 - i, 12 + i, 2 + i * 2, 1, C.goldDark);
    for (let i = 0; i < 5; i++) art.rect(7 + i, 17 + i, 10 - i * 2, 1, C.goldDark);
  }
  // the outside of a cover is the box's bottom face, whose UVs run upside down
  art.texture.center.set(0.5, 0.5);
  art.texture.rotation = Math.PI;
  return art.texture;
}

/** A parchment page that fills with "writing" one word at a time. */
class PageArt {
  readonly art = new Pixels(22, 30);
  private words: Array<[x: number, y: number, w: number, color: number]> = [];
  private written = 0;
  constructor(seed: number, dropCap: boolean, private gutter: number) {
    const rand = random(seed);
    for (let row = 0; row < 11; row++) {
      const y = 4 + row * 2;
      let x = 3;
      if (dropCap && row < 2) {
        if (row === 0) this.words.push([3, 4, 3, C.red]);
        x = 7;
      }
      const end = row === 10 ? 11 : 19;
      while (x < end) {
        const w = Math.min(end - x, 1 + Math.floor(rand() * 3));
        this.words.push([x, y, w, C.ink]);
        x += w + 1;
      }
    }
    this.clear();
  }
  get full() {
    return this.written >= this.words.length;
  }
  clear(scorched = false) {
    this.written = 0;
    this.art.rect(0, 0, 22, 30, C.parchment);
    this.art.rect(0, 29, 22, 1, C.parchmentDark);
    this.art.rect(this.gutter, 0, 1, 30, C.parchmentDark); // shadow where the pages meet
    if (scorched) {
      const rand = random(5);
      for (let i = 0; i < 16; i++) this.art.rect(Math.floor(rand() * 22), Math.floor(rand() * 30), 1 + Math.floor(rand() * 2), 1, rand() > 0.5 ? C.parchmentDark : C.ink);
    }
  }
  write(count = 1) {
    for (; count > 0 && !this.full; count--) {
      const [x, y, w, color] = this.words[this.written++]!;
      this.art.rect(x, y, w, color === C.red ? 3 : 1, color);
    }
  }
  fill() {
    this.write(this.words.length);
  }
}

// ---- poses -------------------------------------------------------------------
const FRONT = 0.95; // yaw that shows the front cover three-quarters on
const OPEN = 0.16; // an open book sits slightly off-square so it reads as 3D
type Pose = { open: number; spin: boolean; yaw: number; clasp: number; glow: number; ash: number; lift: number };
const POSES: Record<SceneState, Pose> = {
  idle: { open: 0, spin: true, yaw: 0, clasp: 0, glow: 0.35, ash: 0, lift: 0 },
  writing: { open: 1, spin: false, yaw: OPEN, clasp: 0, glow: 0.5, ash: 0, lift: 0 },
  sealing: { open: 1, spin: false, yaw: OPEN, clasp: 0, glow: 0.9, ash: 0, lift: 0.1 },
  sealed: { open: 0, spin: false, yaw: FRONT, clasp: 1, glow: 1, ash: 0, lift: 0.15 },
  locked: { open: 0, spin: false, yaw: FRONT, clasp: 1, glow: 0.7, ash: 0, lift: 0 },
  opened: { open: 1, spin: false, yaw: OPEN, clasp: 0, glow: 0.8, ash: 0, lift: 0 },
  revealed: { open: 1, spin: false, yaw: OPEN, clasp: 0, glow: 0.8, ash: 0, lift: 0 },
  gone: { open: 0, spin: false, yaw: FRONT, clasp: 0, glow: 0, ash: 1, lift: -0.45 },
};

// ---- dimensions ----------------------------------------------------------------
const W = 1.5; // cover width
const H = 2.05; // cover height
const COVER = 0.09;
const PAGES = 0.2;
const PAGE_W = W - 0.14;
const PAGE_H = H - 0.24;
const GROUND = -1.55;
const MAX_PARTICLES = 160;

function start(canvas: OffscreenCanvas, width: number, height: number, reduced: boolean) {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "low-power" });
  renderer.setClearAlpha(0);

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
  camera.position.set(0, 3.25, 8);
  camera.lookAt(0, -0.35, 0);

  scene.add(new AmbientLight(0xcfc4ff, 1.5));
  const sun = new DirectionalLight(0xfff0d0, 2.6);
  sun.position.set(-3, 5, 4);
  scene.add(sun);

  // three flat bands of light instead of a smooth gradient
  const bands = new DataTexture(new Uint8Array([110, 180, 255]), 3, 1, RedFormat);
  bands.magFilter = bands.minFilter = NearestFilter;
  bands.needsUpdate = true;
  const tinted: Array<{ material: MeshToonMaterial; base: Color }> = [];
  const toon = (color: number, map?: DataTexture) => {
    const material = new MeshToonMaterial({ color: map ? 0xffffff : color, map: map ?? null, gradientMap: bands });
    tinted.push({ material, base: material.color.clone() });
    return material;
  };

  // spinner (yaw, bob) > tilt (lean back) > book (halves hinge on the gutter)
  const spinner = new Group();
  const tilt = new Group();
  const book = new Group();
  scene.add(spinner);
  spinner.add(tilt);
  tilt.add(book);

  const leather = toon(C.leather);
  const leatherDark = toon(C.leatherDark);
  const edges = toon(C.parchmentDark);
  const leftPage = new PageArt(3, true, 21);
  const rightPage = new PageArt(9, false, 0);
  const pageMaterials = [toon(0, leftPage.art.texture), toon(0, rightPage.art.texture)];

  function half(side: -1 | 1, pageMaterial: MeshToonMaterial, cover: DataTexture) {
    const group = new Group();
    const pages = new Mesh(new BoxGeometry(PAGE_W, PAGES, PAGE_H), [edges, edges, pageMaterial, edges, edges, edges]);
    pages.position.set((side * PAGE_W) / 2, -PAGES / 2, 0);
    const board = new Mesh(new BoxGeometry(W, COVER, H), [leatherDark, leatherDark, leatherDark, toon(0, cover), leatherDark, leatherDark]);
    board.position.set((side * W) / 2, -PAGES - COVER / 2, 0);
    group.add(pages, board);
    book.add(group);
    return group;
  }
  const left = half(-1, pageMaterials[0]!, coverArt(true));
  const right = half(1, pageMaterials[1]!, coverArt(false));

  const spine = new Mesh(new BoxGeometry((PAGES + COVER) * 2, COVER, H), leather);
  book.add(spine);

  const ribbon = new Mesh(new BoxGeometry(0.08, 0.08, 0.5), toon(C.red));
  ribbon.position.set(0, -0.02, PAGE_H / 2 + 0.12);
  book.add(ribbon);

  // loose pages that turn from right to left
  const turning = Array.from({ length: 3 }, () => {
    const pivot = new Group();
    const sheet = new Mesh(new BoxGeometry(PAGE_W, 0.02, PAGE_H), toon(C.parchment));
    sheet.position.set(PAGE_W / 2, 0.015, 0);
    pivot.add(sheet);
    pivot.visible = false;
    book.add(pivot);
    return { pivot, t: -1 };
  });

  // clasp that locks a sealed book, with a gem that glows
  const clasp = new Group();
  const strap = new Mesh(new BoxGeometry((PAGES + COVER) * 2 + 0.12, 0.2, 0.36), toon(C.gold));
  const gemMaterial = new MeshBasicMaterial({ color: C.gem });
  const gem = new Mesh(new BoxGeometry(0.2, 0.1, 0.2), gemMaterial);
  gem.position.y = 0.13;
  clasp.add(strap, gem);
  clasp.position.set(0, W - 0.04, 0);
  book.add(clasp);

  // rune circle and shadow on the ground
  const circle = new Group();
  const runeMaterial = new MeshBasicMaterial({ color: C.gold, transparent: true, blending: AdditiveBlending, depthWrite: false });
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    const rune = new Mesh(new BoxGeometry(i % 5 === 0 ? 0.3 : 0.14, 0.02, 0.14), runeMaterial);
    rune.position.set(Math.cos(angle) * 2.05, 0, Math.sin(angle) * 2.05);
    rune.rotation.y = -angle + Math.PI / 2;
    circle.add(rune);
  }
  circle.position.y = GROUND;
  const shadow = new Mesh(new CircleGeometry(1, 16), new MeshBasicMaterial({ color: 0x05030a, transparent: true, opacity: 0.5, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = GROUND + 0.01;
  scene.add(circle, shadow);

  // square pixel sparks
  const positions = new Float32Array(MAX_PARTICLES * 3).fill(999);
  const colors = new Float32Array(MAX_PARTICLES * 3);
  const sparks = Array.from({ length: MAX_PARTICLES }, () => ({ life: 0, span: 1, vx: 0, vy: 0, vz: 0, color: new Color() }));
  const sparkGeometry = new BufferGeometry();
  sparkGeometry.setAttribute("position", new BufferAttribute(positions, 3));
  sparkGeometry.setAttribute("color", new BufferAttribute(colors, 3));
  const points = new Points(sparkGeometry, new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false }));
  points.frustumCulled = false;
  scene.add(points);
  let nextSpark = 0;
  function spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number, span: number) {
    const i = nextSpark++ % MAX_PARTICLES;
    const s = sparks[i]!;
    Object.assign(s, { life: span, span, vx, vy, vz });
    s.color.set(color);
    positions.set([x, y, z], i * 3);
  }
  function burst(count: number, color: number, speed: number) {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const push = speed * (0.5 + Math.random() * 0.5);
      spark(0, spinner.position.y + 0.2, 0.6, Math.cos(angle) * push, Math.sin(angle) * push * 0.9 + 0.4, Math.random() - 0.5, color, 0.6 + Math.random() * 0.7);
    }
  }

  // ---- state -----------------------------------------------------------------
  let state: SceneState = "idle";
  let pose = POSES.idle;
  const now = { open: 0, yaw: 0, tilt: Math.PI / 2, clasp: 0, glow: 0.35, ash: 0, lift: 0 };
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  let shake = 0;
  let flipTimer = 0;
  let emitTimer = 0;
  let fadeWriting = -1; // seconds until the revealed writing burns away
  let running = true;
  let looping = false;
  let last = 0;
  let pulses = 0;

  function flip() {
    const page = turning.find((item) => item.t < 0);
    if (page && now.open > 0.8 && !reduced) page.t = 0;
  }

  function setState(name: SceneState) {
    if (name === state) return;
    const from = state;
    state = name;
    pose = POSES[name];
    fadeWriting = -1;
    if (name === "idle" || (name === "writing" && from !== "idle" && from !== "sealing")) leftPage.clear(), rightPage.clear();
    if (name === "sealing") leftPage.fill(), rightPage.fill();
    if (name === "sealed") burst(46, C.gold, 3.2);
    if (name === "revealed" || name === "opened") {
      leftPage.clear(), rightPage.clear();
      leftPage.fill(), rightPage.fill();
      burst(40, C.gem, 3);
      if (name === "revealed") fadeWriting = 2.2;
    }
    if (name === "gone") burst(18, C.ash, 1.4);
    if (reduced) draw(1, 0);
  }

  function resize(w: number, h: number) {
    if (w < 2 || h < 2) return;
    const pixel = Math.min(4, Math.max(2, Math.round(h / 150)));
    renderer.setSize(Math.ceil(w / pixel), Math.ceil(h / pixel), false);
    const aspect = w / h;
    const viewHeight = Math.max(4.5, 4.4 / aspect);
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.right = (viewHeight * aspect) / 2;
    camera.left = -camera.right;
    camera.updateProjectionMatrix();
    if (reduced) draw(1, 0);
  }

  const ashColor = new Color(C.ash);
  const glowColor = new Color();

  function draw(dt: number, time: number) {
    const ease = reduced ? 1 : 1 - Math.exp(-dt * 5.5);
    const slow = reduced ? 1 : 1 - Math.exp(-dt * 2.5);
    pointer.sx += (pointer.x - pointer.sx) * slow;
    pointer.sy += (pointer.y - pointer.sy) * slow;

    if (pose.spin && !reduced) {
      now.yaw += dt * 0.85;
    } else {
      const sway = reduced ? 0 : Math.sin(time * 0.9) * (pose.open ? 0.07 : 0.22);
      const want = pose.yaw + sway + pointer.sx * 0.3;
      const target = want + Math.PI * 2 * Math.round((now.yaw - want) / (Math.PI * 2));
      now.yaw += (target - now.yaw) * (reduced ? 1 : 1 - Math.exp(-dt * 3.2));
    }
    // turn to face the reader before opening
    const facing = Math.abs(Math.sin((now.yaw - pose.yaw) / 2)) < 0.25;
    now.open += ((pose.open === 1 && !facing ? now.open : pose.open) - now.open) * ease;
    now.clasp += ((now.open < 0.08 ? pose.clasp : 0) - now.clasp) * ease;
    now.glow += (pose.glow - now.glow) * slow;
    now.ash += (pose.ash - now.ash) * slow;
    now.lift += (pose.lift - now.lift) * slow;
    now.tilt += ((pose.open ? 0.82 : Math.PI / 2) + (pose.open ? pointer.sy * 0.12 : 0) - now.tilt) * ease;

    const closed = 1 - now.open;
    left.rotation.z = (-closed * Math.PI) / 2;
    right.rotation.z = (closed * Math.PI) / 2;
    spine.position.y = -COVER / 2 - now.open * PAGES;
    book.position.y = (-closed * W) / 2;
    tilt.rotation.x = now.tilt;
    spinner.rotation.y = now.yaw;
    shake *= Math.exp(-dt * 6);
    const bob = reduced ? 0 : Math.sin(time * 1.7) * 0.09;
    spinner.position.set(Math.sin(time * 42) * shake, now.lift + bob + 0.1, 0);
    spinner.rotation.z = now.ash * 0.22;

    clasp.scale.setScalar(Math.max(0.001, now.clasp));
    clasp.visible = now.clasp > 0.02;
    const pulse = reduced ? 1 : 0.75 + Math.sin(time * 3.2) * 0.25;
    gemMaterial.color.set(C.gem).multiplyScalar(0.5 + now.glow * pulse);

    for (const { material, base } of tinted) material.color.copy(base).lerp(ashColor, now.ash * 0.85);

    circle.rotation.y = reduced ? 0 : time * 0.35;
    glowColor.set(shake > 0.02 ? C.red : C.gold).multiplyScalar(now.glow * (0.55 + pulse * 0.45));
    runeMaterial.color.copy(glowColor);
    shadow.scale.setScalar(1.15 + now.open * 0.5 - (now.lift + bob) * 0.25);

    // pages that are mid-turn
    if (state === "sealing" && (flipTimer -= dt) <= 0) {
      flip();
      flipTimer = 0.16;
    }
    for (const page of turning) {
      if (page.t < 0) continue;
      page.t += dt * 2.4;
      if (page.t >= 1 || now.open < 0.6) page.t = -1;
      page.pivot.visible = page.t >= 0;
      const eased = page.t * page.t * (3 - 2 * page.t);
      page.pivot.rotation.z = eased * Math.PI;
    }

    if (fadeWriting > 0 && (fadeWriting -= dt) <= 0) {
      leftPage.clear(true), rightPage.clear(true);
      burst(30, C.ember, 2.2);
    }

    // sparks
    if (!reduced) {
      emitTimer -= dt;
      const rate = state === "gone" ? 0.5 : state === "revealed" && fadeWriting < 0 ? 0.09 : 0.24 - now.glow * 0.14;
      if (emitTimer <= 0) {
        emitTimer = rate;
        const angle = Math.random() * Math.PI * 2;
        const reach = 0.5 + Math.random() * 1.6;
        const color = state === "gone" ? C.ash : state === "revealed" && fadeWriting < 0 ? C.ember : Math.random() > 0.8 ? C.gem : C.gold;
        const fromBook = state === "revealed";
        spark(Math.cos(angle) * reach * (fromBook ? 0.6 : 1), fromBook ? 0 : GROUND + 0.1, Math.sin(angle) * reach * 0.5 + (fromBook ? 0.9 : 0), 0, 0.45 + Math.random() * 0.5, 0, color, 1.6 + Math.random() * 1.4);
      }
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const s = sparks[i]!;
        if (s.life <= 0) continue;
        s.life -= dt;
        if (s.life <= 0) {
          positions[i * 3 + 1] = 999;
          continue;
        }
        s.vx *= 1 - dt * 1.8;
        s.vz *= 1 - dt * 1.8;
        positions[i * 3]! += s.vx * dt;
        positions[i * 3 + 1]! += s.vy * dt;
        positions[i * 3 + 2]! += s.vz * dt;
        const fade = Math.min(1, (s.life / s.span) * 2);
        colors[i * 3] = s.color.r * fade;
        colors[i * 3 + 1] = s.color.g * fade;
        colors[i * 3 + 2] = s.color.b * fade;
      }
      sparkGeometry.attributes.position!.needsUpdate = true;
      sparkGeometry.attributes.color!.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  function frame(ms: number) {
    looping = running && !reduced;
    if (!looping) return;
    requestAnimationFrame(frame);
    const time = ms / 1000;
    const dt = time - last;
    if (dt < 1 / 34) return; // ~30 fps: enough for pixel art, easy on batteries
    last = time;
    draw(Math.min(dt, 0.1), time);
  }

  resize(width, height);
  draw(1, 0);
  requestAnimationFrame(frame);

  return (message: SceneMessage) => {
    if (message.type === "resize") resize(message.width, message.height);
    else if (message.type === "state") setState(message.name);
    else if (message.type === "pointer") (pointer.x = message.x), (pointer.y = message.y);
    else if (message.type === "shake") (shake = reduced ? 0 : 0.22), burst(14, C.red, 2);
    else if (message.type === "pulse") {
      const page = leftPage.full ? rightPage : leftPage;
      page.write();
      if (rightPage.full) {
        leftPage.clear(), rightPage.clear();
        flip();
      }
      if (!reduced && ++pulses % 2 === 0) spark((Math.random() - 0.5) * 2.2, 0.5, 1, 0, 0.9, 0, C.gold, 0.7);
      if (reduced) draw(1, 0);
    } else if (message.type === "visible") {
      running = message.on;
      if (running && !looping) requestAnimationFrame(frame);
    }
  };
}

// ---- worker entry ----------------------------------------------------------------
if (typeof document === "undefined") {
  let handle: ((message: SceneMessage) => void) | undefined;
  const pending: SceneMessage[] = [];
  addEventListener("message", (event: MessageEvent<SceneMessage>) => {
    const message = event.data;
    if (message.type !== "init") return handle ? handle(message) : void pending.push(message);
    try {
      handle = start(message.canvas, message.width, message.height, message.reduced);
      pending.forEach(handle);
      postMessage("ready");
    } catch {
      postMessage("failed");
    }
  });
}
