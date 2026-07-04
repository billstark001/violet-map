import * as THREE from 'three';

/** 指针锁定 + WASD/空格/Shift 的飞行控制。 */
export class FlyControls {
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.dom) return;
    this.yaw -= e.movementX * 0.0025;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch - e.movementY * 0.0025));
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
  };
  private onClick = () => this.dom.requestPointerLock();

  constructor(private dom: HTMLElement, private camera: THREE.PerspectiveCamera) {
    camera.rotation.order = 'YXZ';
    dom.addEventListener('click', this.onClick);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('keyup', this.onKey);
  }

  update(dt: number) {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    const speed = (this.keys.has('ControlLeft') ? 48 : 12) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.sub(forward);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('Space')) move.y += 1;
    if (this.keys.has('ShiftLeft')) move.y -= 1;
    if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), speed);
  }

  dispose() {
    this.dom.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('keyup', this.onKey);
  }
}