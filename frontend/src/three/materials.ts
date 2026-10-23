import * as THREE from 'three';

/**
 * 3D 재질 토큰. 밝은 건축 모형의 정돈된 분위기를 유지하면서 표면마다 거칠기·명도를 조금씩 다르게 둡니다.
 * - 바닥: 사무 공간(어둡고 거침) < 계단실 < 복도(밝고 약간 매끈) — 동선이 읽히도록
 * - 벽: 내벽(밝은 무광) · 외벽(한 톤 어둡게) · 절단면 캡(가장 밝게, 윤곽 강조)
 * - 유리: 낮은 불투명도 + 클리어코트. 환경광(TwinCanvas 의 절차적 RoomEnvironment)을 약하게 반사합니다.
 * - 금속·광택은 최소(번쩍이거나 플라스틱처럼 보이지 않도록 metalness 대부분 0).
 * 새 구조물이나 시설은 추가하지 않습니다(기존 형상에 재질만 입힘).
 */
const std = (color: string, roughness = 0.9, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });

export const M = {
  ground: std('#0F1114', 1),
  site: std('#171A1E', 0.98),
  sidewalk: std('#22262B', 0.95),
  slab: std('#2A2E34', 0.82),
  slabEdge: std('#3A3F46', 0.8),
  corridor: std('#464B52', 0.74),
  room: std('#2C3035', 0.94),
  stairFloor: std('#393E45', 0.85),
  wall: std('#E1E4E8', 0.86),
  wallExterior: std('#C3C8CE', 0.9),
  wallTop: std('#F6F8FA', 0.68),
  glass: new THREE.MeshPhysicalMaterial({
    color: '#A8C3D6',
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    ior: 1.45,
    envMapIntensity: 2.6,
  }),
  frame: std('#7D858E', 0.48, { metalness: 0.3 }),
  desk: std('#D5D8DC', 0.66),
  deskDark: std('#A0A6AD', 0.72),
  chair: std('#32363C', 0.82),
  screen: std('#14171B', 0.32, { metalness: 0.1 }),
  sofa: std('#AEB3BA', 0.96),
  plant: std('#53735C', 0.9),
  pot: std('#878D95', 0.7),
  step: std('#C2C6CB', 0.84),
  tree: std('#2A3034', 0.95),
  trunk: std('#383D42', 0.95),
  ghost: new THREE.MeshStandardMaterial({ color: '#C9CCD0', transparent: true, opacity: 0.08, depthWrite: false, roughness: 1 }),
  ghostSlab: new THREE.MeshStandardMaterial({ color: '#3A3E44', transparent: true, opacity: 0.35, depthWrite: false, roughness: 1 }),
  exitSign: new THREE.MeshStandardMaterial({ color: '#3FB27F', emissive: '#3FB27F', emissiveIntensity: 0.9, roughness: 0.5 }),
  exitSignBlocked: new THREE.MeshStandardMaterial({ color: '#E5484D', emissive: '#E5484D', emissiveIntensity: 0.9, roughness: 0.5 }),
  /** 슬래브 윤곽의 절제된 림(얇은 선, 발광 아님) */
  rimEdge: new THREE.LineBasicMaterial({ color: '#A9D6FF', transparent: true, opacity: 0.16, depthWrite: false }),
};

export const COLORS = {
  ok: '#3FB27F',
  warn: '#E08A3C',
  fail: '#E5484D',
  action: '#7CC8FF',
  unknown: '#6B727C',
  route: '#4CC38A',
};
