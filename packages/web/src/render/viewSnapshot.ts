import * as THREE from 'three';
import type { ViewState } from '../view/state';
import { normalizeTopClipRange, type TopClipRange } from '../view/worldGeometry';

const direction = new THREE.Vector3();

export function captureView(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  topView: boolean,
  clip: TopClipRange,
): ViewState {
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(direction);
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
    projection:
      camera instanceof THREE.PerspectiveCamera
        ? {
            kind: 'perspective',
            fovYRadians: THREE.MathUtils.degToRad(camera.fov),
            aspect: camera.aspect,
            zoom: camera.zoom,
            near: camera.near,
          }
        : {
            kind: 'orthographic',
            left: camera.left,
            right: camera.right,
            top: camera.top,
            bottom: camera.bottom,
            zoom: camera.zoom,
            near: camera.near,
          },
    mode: topView ? 'top' : 'perspective',
    clip: normalizeTopClipRange(clip, null),
  };
}
