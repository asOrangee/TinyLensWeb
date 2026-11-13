import { mapperFromEvaluator, type PlaneFrame, type Point } from './lens-mapping.ts';

export type EplShearModel = {
  kind: 'epl-shear'; theta_E: number; gamma: number; e1_mass: number; e2_mass: number;
  center_x_mass: number; center_y_mass: number; gamma1: number; gamma2: number;
};

/** TinyLensGpu EPL angular recurrence and its differentiated terms. */
export function eplMapper(model: EplShearModel, frame: PlaneFrame) {
  const { theta_E: thetaE, gamma, e1_mass, e2_mass, center_x_mass, center_y_mass, gamma1, gamma2 } = model;
  if (model.kind !== 'epl-shear' || ![thetaE, gamma, e1_mass, e2_mass, center_x_mass, center_y_mass, gamma1, gamma2].every(Number.isFinite) || thetaE <= 0 || gamma < 1 || gamma > 3) {
    throw new Error('Unsupported saved EPL model');
  }
  const center = { x: center_x_mass, y: center_y_mass };
  const e1 = e1_mass || 1e-12, e2 = e2_mass || 1e-12;
  const ellipticity = Math.min(.9999, Math.hypot(e1, e2));
  const axisRatio = (1 - ellipticity) / (1 + ellipticity);
  const angle = Math.atan2(e2, e1) / 2, cosAngle = Math.cos(angle), sinAngle = Math.sin(angle);
  const scale = thetaE * Math.sqrt(axisRatio), slope = gamma - 1;
  const flattening = (1 - axisRatio) / (1 + axisRatio);
  const prefactor = 2 * scale / (1 + axisRatio), minRadius = 1e-9;
  const terms = Array.from({ length: 50 }, (_, index) => {
    const n = index + 1;
    return { factor: -flattening * (2 * n - (2 - slope)) / (2 * n + (2 - slope)), frequency: 2 * n + 1 };
  });

  function evaluate(point: Point) {
    const dx = point.x - center.x, dy = point.y - center.y;
    const u = axisRatio * (cosAngle * dx + sinAngle * dy), v = -sinAngle * dx + cosAngle * dy;
    const rawRadius = Math.hypot(u, v), radius = Math.max(rawRadius, minRadius);
    const cosPhi = rawRadius === 0 ? 1 : u / rawRadius, sinPhi = rawRadius === 0 ? 0 : v / rawRadius;
    const cosTwice = cosPhi * cosPhi - sinPhi * sinPhi, sinTwice = 2 * cosPhi * sinPhi;
    let real = cosPhi, imaginary = sinPhi, omegaX = real, omegaY = imaginary;
    let omegaPhiX = -imaginary, omegaPhiY = real;
    for (const { factor, frequency } of terms) {
      const nextReal = factor * (real * cosTwice - imaginary * sinTwice);
      imaginary = factor * (real * sinTwice + imaginary * cosTwice);
      real = nextReal;
      omegaX += real;
      omegaY += imaginary;
      omegaPhiX -= frequency * imaginary;
      omegaPhiY += frequency * real;
    }

    const amplitude = prefactor * (scale / radius) ** (slope - 1);
    const radialDerivative = rawRadius > minRadius ? (1 - slope) / rawRadius : 0;
    const angularRadius = rawRadius || minRadius;
    const radialX = radialDerivative * axisRatio * cosPhi, radialY = radialDerivative * sinPhi;
    const phiX = -axisRatio * sinPhi / angularRadius, phiY = cosPhi / angularRadius;
    const localXX = amplitude * (omegaX * radialX + omegaPhiX * phiX);
    const localXY = amplitude * (omegaX * radialY + omegaPhiX * phiY);
    const localYX = amplitude * (omegaY * radialX + omegaPhiY * phiX);
    const localYY = amplitude * (omegaY * radialY + omegaPhiY * phiY);
    const localXdx = cosAngle * localXX - sinAngle * localXY, localXdy = sinAngle * localXX + cosAngle * localXY;
    const localYdx = cosAngle * localYX - sinAngle * localYY, localYdy = sinAngle * localYX + cosAngle * localYY;

    return {
      x: (1 - gamma1) * point.x - gamma2 * point.y - amplitude * (cosAngle * omegaX - sinAngle * omegaY),
      y: (1 + gamma1) * point.y - gamma2 * point.x - amplitude * (sinAngle * omegaX + cosAngle * omegaY),
      xx: 1 - gamma1 - (cosAngle * localXdx - sinAngle * localYdx),
      xy: -gamma2 - (cosAngle * localXdy - sinAngle * localYdy),
      yx: -gamma2 - (sinAngle * localXdx + cosAngle * localYdx),
      yy: 1 + gamma1 - (sinAngle * localXdy + cosAngle * localYdy),
    };
  }

  // Use the circular radial-critical scale to refine the mesh around the mass center.
  const coreExtent = slope > 0 && slope < 1
    ? Math.min(frame.half_extent_arcsec, 2 * scale / axisRatio * (1 - slope) ** (1 / slope)) : 0;
  const mapper = mapperFromEvaluator(evaluate, frame, coreExtent, center);
  const outsideFloor = (point: Point) => {
    const dx = point.x - center.x, dy = point.y - center.y;
    return Math.hypot(axisRatio * (cosAngle * dx + sinAngle * dy), -sinAngle * dx + cosAngle * dy) > minRadius * (1 + 1e-6);
  };
  let curves: ReturnType<typeof mapper.criticalCurves> | undefined;
  return {
    ...mapper,
    imagesFor: (source: Point) => mapper.imagesFor(source).filter(outsideFloor),
    criticalCurves: () => curves ??= mapper.criticalCurves().filter(curve => curve.critical.every(outsideFloor)),
  };
}
