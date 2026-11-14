/**
 * Deterministic force-directed layout shared by the static SVG view and the Explorer. Equal input gives equal output,
 * so a rebuilt graph draws the same picture and the Explorer's model can be compared across runs.
 */

export const LAYOUT_WIDTH = 1200;
export const LAYOUT_HEIGHT = 800;

export interface Point { x: number; y: number }

/** Hue per subsystem; the golden-angle step keeps neighbouring ids visually distinct. */
export const communityColor = (id: number) => `hsl(${Math.round((id * 137.508) % 360)},62%,52%)`;

/** Subsystem centres on a ring, so each cluster starts in its own region. */
export function ringSeeds(communities: number[], width = LAYOUT_WIDTH, height = LAYOUT_HEIGHT): Map<number, Point> {
  const seeds = new Map<number, Point>();
  communities.forEach((c, i) => {
    const angle = (i / communities.length) * Math.PI * 2;
    seeds.set(c, { x: width / 2 + 0.33 * width * Math.cos(angle), y: height / 2 + 0.33 * height * Math.sin(angle) });
  });
  return seeds;
}

/** Fruchterman-Reingold style layout started from a fixed arrangement, so equal input gives equal output. */
export function layout(
  count: number,
  community: number[],
  links: [number, number, number][],
  seeds: Map<number, Point>,
  width = LAYOUT_WIDTH,
  height = LAYOUT_HEIGHT,
): Point[] {
  const members = new Map<number, number[]>();
  community.forEach((c, i) => { const list = members.get(c); if (list) list.push(i); else members.set(c, [i]); });
  const points: Point[] = new Array(count);
  for (const [c, list] of members) {
    const center = seeds.get(c)!;
    list.forEach((node, k) => {
      const angle = k * 2.399963;
      const radius = 14 * Math.sqrt(k + 1);
      points[node] = { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
    });
  }
  const area = width * height;
  const spring = Math.sqrt(area / Math.max(1, count)) * 0.9;
  const iterations = count > 800 ? 40 : count > 300 ? 80 : 150;
  let temperature = width / 10;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  for (let step = 0; step < iterations; step++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let rx = points[i].x - points[j].x;
        let ry = points[i].y - points[j].y;
        let d2 = rx * rx + ry * ry;
        if (d2 < 0.01) { rx = (i - j) * 0.1; ry = 0.1; d2 = rx * rx + ry * ry; }
        const force = (spring * spring) / d2;
        dx[i] += rx * force; dy[i] += ry * force;
        dx[j] -= rx * force; dy[j] -= ry * force;
      }
    }
    for (const [a, b, weight] of links) {
      const rx = points[a].x - points[b].x;
      const ry = points[a].y - points[b].y;
      const d = Math.sqrt(rx * rx + ry * ry) || 0.01;
      const force = (d * Math.min(3, 0.5 + weight)) / spring / 4;
      dx[a] -= rx * force; dy[a] -= ry * force;
      dx[b] += rx * force; dy[b] += ry * force;
    }
    for (let i = 0; i < count; i++) {
      const center = seeds.get(community[i])!;
      dx[i] += (center.x - points[i].x) * 0.02;
      dy[i] += (center.y - points[i].y) * 0.02;
      const length = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const move = Math.min(length, temperature);
      points[i].x += (dx[i] / length) * move;
      points[i].y += (dy[i] / length) * move;
    }
    temperature *= 0.96;
  }
  return points;
}
