import * as THREE from 'three';

export interface FlyView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface TopView {
  x: number;
  y: number;
  z: number;
  zoom: number;
}

export type TopDownCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function normalizeFlyYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const twoPi = Math.PI * 2;
  return ((yaw + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

export function clampFlyPitch(pitch: number): number {
  return Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, Number.isFinite(pitch) ? pitch : 0));
}

/** 指针锁定 + WASD/空格/Shift 的飞行控制。 */
export class FlyControls {
  private keys = new Set<string>();
  private enabled = true;
  private yaw = 0;
  private pitch = 0;
  private baseSpeed = 12;
  private fastMultiplier = 4;
  inertiaEnabled = false;
  velocity = new THREE.Vector3();
  acceleration = 48;
  damping = 4.5;
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private onMouseMove = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (document.pointerLockElement !== this.dom) return;
    this.yaw = normalizeFlyYaw(this.yaw - e.movementX * 0.0025);
    this.pitch = clampFlyPitch(this.pitch - e.movementY * 0.0025);
  };
  private onKey = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (isEditableTarget(e.target)) return;
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
  };
  private onClick = () => {
    if (this.enabled) this.dom.requestPointerLock();
  };
  private onBlur = () => {
    this.keys.clear();
    if (!this.inertiaEnabled) this.velocity.set(0, 0, 0);
  };

  constructor(private dom: HTMLElement, private camera: THREE.Camera, initial?: Pick<FlyView, 'yaw' | 'pitch'>) {
    camera.rotation.order = 'YXZ';
    if (initial) this.setAngles(initial.yaw, initial.pitch);
    else this.syncFromCamera();
    dom.addEventListener('click', this.onClick);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
  }

  update(dt: number) {
    if (!this.enabled) return;
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    const multiplier = this.keys.has('ControlLeft') ? this.fastMultiplier : 1;
    const speed = this.baseSpeed * multiplier;
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(-this.forward.z, 0, this.forward.x);
    this.move.set(0, 0, 0);
    if (this.keys.has('KeyW')) this.move.add(this.forward);
    if (this.keys.has('KeyS')) this.move.sub(this.forward);
    if (this.keys.has('KeyD')) this.move.add(this.right);
    if (this.keys.has('KeyA')) this.move.sub(this.right);
    if (this.keys.has('Space')) this.move.y += 1;
    if (this.keys.has('ShiftLeft')) this.move.y -= 1;

    if (!this.inertiaEnabled) {
      this.velocity.set(0, 0, 0);
      if (this.move.lengthSq() > 0) this.camera.position.addScaledVector(this.move.normalize(), speed * dt);
      return;
    }

    if (this.move.lengthSq() > 0) {
      this.velocity.addScaledVector(this.move.normalize(), this.acceleration * multiplier * dt);
      if (this.velocity.length() > speed) this.velocity.setLength(speed);
    } else {
      this.velocity.multiplyScalar(Math.exp(-this.damping * dt));
      if (this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);
    }
    this.camera.position.addScaledVector(this.velocity, dt);
  }

  setAngles(yaw: number, pitch: number) {
    this.yaw = normalizeFlyYaw(yaw);
    this.pitch = clampFlyPitch(pitch);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  setPosition(x: number, y: number, z: number) {
    this.camera.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
  }

  setFastMultiplier(value: number) {
    this.fastMultiplier = Math.max(1, Math.min(16, Number.isFinite(value) ? value : 4));
  }

  setInertiaEnabled(value: boolean) {
    this.inertiaEnabled = value;
    if (!value) this.velocity.set(0, 0, 0);
  }

  setEnabled(value: boolean) {
    if (this.enabled === value) return;
    this.enabled = value;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    if (!value && document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  syncFromCamera() {
    this.yaw = normalizeFlyYaw(this.camera.rotation.y);
    this.pitch = clampFlyPitch(this.camera.rotation.x);
  }

  getView(): FlyView {
    return {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  dispose() {
    this.dom.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
  }
}

/** 正交顶视图控制：锁定垂直俯视，只允许平移和缩放。 */
export class TopDownControls {
  private keys = new Set<string>();
  private enabled = true;
  private baseSpeed = 96;
  private fastMultiplier = 4;
  private dragging = false;
  private readonly move = new THREE.Vector3();
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (isEditableTarget(e.target)) return;
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
  };
  private readonly onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.camera.zoom = Math.max(0.05, Math.min(32, this.camera.zoom * factor));
    } else {
      this.camera.position.y = Math.max(32, Math.min(4096, this.camera.position.y / factor));
    }
    this.camera.updateProjectionMatrix();
  };
  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (isEditableTarget(e.target) || e.button !== 0) return;
    this.dragging = true;
    this.dom.setPointerCapture(e.pointerId);
  };
  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.enabled || !this.dragging) return;
    const worldPerPixel = this.worldPerPixel();
    this.camera.position.x -= e.movementX * worldPerPixel;
    this.camera.position.z -= e.movementY * worldPerPixel;
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
  };
  private readonly onBlur = () => {
    this.keys.clear();
    this.dragging = false;
  };

  constructor(private dom: HTMLElement, private camera: TopDownCamera, initial?: Partial<TopView>) {
    this.camera.rotation.order = 'YXZ';
    this.lockTopDown();
    if (initial) {
      this.camera.position.set(
        Number.isFinite(initial.x) ? initial.x! : this.camera.position.x,
        Number.isFinite(initial.y) ? initial.y! : this.camera.position.y,
        Number.isFinite(initial.z) ? initial.z! : this.camera.position.z,
      );
      if (this.camera instanceof THREE.OrthographicCamera) {
        this.camera.zoom = Math.max(0.05, Math.min(32, Number.isFinite(initial.zoom) ? initial.zoom! : this.camera.zoom));
      }
      this.camera.updateProjectionMatrix();
    }
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('keyup', this.onKey);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('blur', this.onBlur);
  }

  update(dt: number) {
    if (!this.enabled) return;
    this.lockTopDown();
    const multiplier = this.keys.has('ControlLeft') ? this.fastMultiplier : 1;
    this.move.set(0, 0, 0);
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.move.z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.move.z += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.move.x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.move.x -= 1;
    const scale = this.camera instanceof THREE.OrthographicCamera ? 1 / Math.sqrt(this.camera.zoom) : Math.max(0.25, this.camera.position.y / 512);
    if (this.move.lengthSq() > 0) this.camera.position.addScaledVector(this.move.normalize(), this.baseSpeed * multiplier * dt * scale);
  }

  setPosition(x: number, y: number, z: number) {
    this.camera.position.set(x, y, z);
    this.lockTopDown();
  }

  setFastMultiplier(value: number) {
    this.fastMultiplier = Math.max(1, Math.min(16, Number.isFinite(value) ? value : 4));
  }

  resize(aspect: number, frustumHeight: number) {
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.camera.left = -frustumHeight * aspect / 2;
      this.camera.right = frustumHeight * aspect / 2;
      this.camera.top = frustumHeight / 2;
      this.camera.bottom = -frustumHeight / 2;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
  }

  setEnabled(value: boolean) {
    if (this.enabled === value) return;
    this.enabled = value;
    this.keys.clear();
    this.dragging = false;
  }

  syncFromCamera() {
    this.lockTopDown();
  }

  getView(): TopView {
    return {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
      zoom: this.camera instanceof THREE.OrthographicCamera ? this.camera.zoom : 512 / Math.max(1, this.camera.position.y),
    };
  }

  dispose() {
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('keyup', this.onKey);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private lockTopDown() {
    this.camera.rotation.set(-Math.PI / 2, 0, 0);
  }

  private worldPerPixel(): number {
    const height = Math.max(1, this.dom.clientHeight);
    if (this.camera instanceof THREE.OrthographicCamera) {
      return ((this.camera.top - this.camera.bottom) / this.camera.zoom) / height;
    }
    return (2 * Math.max(1, this.camera.position.y) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5)) / height;
  }
}
