"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NextPage } from "next";

// ============================================
// TYPES
// ============================================

type TileType = "ground" | "border" | "food" | "spider" | "nest";
type AntState = "explore" | "return" | "harvest" | "defend";
type GlobalDirective = "explore" | "harvest" | "defend";

// Continuous 2D position (not grid-locked)
interface Vec2 {
  x: number;
  y: number;
}

interface Ant {
  id: number;
  pos: Vec2; // Continuous position in world space
  velocity: Vec2; // Current velocity
  state: AntState;
  carriedInfo: "food" | "danger" | null;
  trail: Vec2[]; // Sampled positions for trail rendering
  isAlive: boolean;
  wanderAngle: number; // For smooth wandering behavior
  color: string;
  lastTrailSample: number; // Time of last trail sample
}

interface Tile {
  type: TileType;
  homePheromone: number;
  foodPheromone: number;
  revealed: boolean;
}

interface GameState {
  map: Tile[][];
  ants: Ant[];
  directive: GlobalDirective;
  food: number;
  maxFood: number;
  tick: number;
  gameOver: boolean;
  won: boolean;
  ticksSinceLastFood: number;
  nestPos: Vec2; // Center of nest in world coordinates
  antIdCounter: number;
}

// ============================================
// CONSTANTS
// ============================================

const MAP_SIZE = 20;
const TILE_SIZE = 32;
const CANVAS_SIZE = MAP_SIZE * TILE_SIZE;
const WORLD_SIZE = MAP_SIZE; // World units (1 unit = 1 tile)

// Ant movement physics
const ANT_MAX_SPEED = 0.024; // World units per frame (30% of original)
const ANT_MAX_FORCE = 0.0012; // Steering force limit (30% of original)
const ANT_WANDER_STRENGTH = 0.3;
const ANT_WANDER_RATE = 0.1; // How fast wander angle changes

// Trail settings
const TRAIL_SAMPLE_INTERVAL = 100; // ms between trail samples
const TRAIL_MAX_LENGTH = 150; // Max trail points
const TRAIL_FADE_START = 0.3; // Start fading at this % of trail

// Pheromone settings
const PHEROMONE_DECAY = 0.002;
const PHEROMONE_DEPOSIT_RATE = 0.15;

// Game settings
const MAX_ANTS = 15;
const INITIAL_ANTS = 1; // Reduced for testing
const INITIAL_FOOD = 5;
const WIN_FOOD = 30;
const STARVATION_TICKS = 300;
const MIN_ANTS_TO_SURVIVE = 1;
const SPAWN_FOOD_COST = 5;
const GAME_TICK_INTERVAL = 1000; // ms for game logic tick

// Ant colors
const ANT_COLORS = [
  "#FF6B6B",
  "#4ECDC4",
  "#45B7D1",
  "#96CEB4",
  "#FFEAA7",
  "#DDA0DD",
  "#98D8C8",
  "#F7DC6F",
  "#BB8FCE",
  "#85C1E9",
  "#F8B500",
  "#00CED1",
  "#FF69B4",
  "#7FFF00",
  "#FF4500",
];

const MAP_TEMPLATE = [
  "🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫",
  "🟫..............F...🟫",
  "🟫......F.....S.....🟫",
  "🟫..................🟫",
  "🟫..............F...🟫",
  "🟫..................🟫",
  "🟫..................🟫",
  "🟫...S..............🟫",
  "🟫..................🟫",
  "🟫.........N........🟫",
  "🟫..................🟫",
  "🟫..................🟫",
  "🟫.......F..........🟫",
  "🟫..................🟫",
  "🟫..................🟫",
  "🟫............S.....🟫",
  "🟫..................🟫",
  "🟫..F...............🟫",
  "🟫..................🟫",
  "🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫🟫",
];

// ============================================
// VECTOR MATH
// ============================================

const vec2 = {
  create: (x: number, y: number): Vec2 => ({ x, y }),
  add: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s }),
  length: (v: Vec2): number => Math.sqrt(v.x * v.x + v.y * v.y),
  normalize: (v: Vec2): Vec2 => {
    const len = vec2.length(v);
    return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
  },
  limit: (v: Vec2, max: number): Vec2 => {
    const len = vec2.length(v);
    if (len > max) {
      return vec2.scale(vec2.normalize(v), max);
    }
    return v;
  },
  distance: (a: Vec2, b: Vec2): number => vec2.length(vec2.sub(a, b)),
  angle: (v: Vec2): number => Math.atan2(v.y, v.x),
  fromAngle: (angle: number, length: number = 1): Vec2 => ({
    x: Math.cos(angle) * length,
    y: Math.sin(angle) * length,
  }),
  lerp: (a: Vec2, b: Vec2, t: number): Vec2 => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }),
  copy: (v: Vec2): Vec2 => ({ x: v.x, y: v.y }),
};

// ============================================
// HELPER FUNCTIONS
// ============================================

const parseMapTemplate = (): { tiles: Tile[][]; nestPos: Vec2 } => {
  let nestPos: Vec2 = { x: 10.5, y: 9.5 }; // Center of tile
  const tiles: Tile[][] = [];

  for (let y = 0; y < MAP_SIZE; y++) {
    tiles[y] = [];
    const row = MAP_TEMPLATE[y];
    let x = 0;
    let charIndex = 0;

    while (x < MAP_SIZE && charIndex < row.length) {
      const char = row[charIndex];
      let type: TileType = "ground";

      if (char === "🟫") {
        type = "border";
        charIndex += 2;
      } else if (char === "F") {
        type = "food";
        charIndex += 1;
      } else if (char === "S") {
        type = "spider";
        charIndex += 1;
      } else if (char === "N") {
        type = "nest";
        nestPos = { x: x + 0.5, y: y + 0.5 };
        charIndex += 1;
      } else {
        type = "ground";
        charIndex += 1;
      }

      tiles[y][x] = {
        type,
        homePheromone: type === "nest" ? 1 : 0,
        foodPheromone: 0,
        revealed: type === "nest" || type === "border",
      };
      x++;
    }

    while (x < MAP_SIZE) {
      tiles[y][x] = {
        type: "ground",
        homePheromone: 0,
        foodPheromone: 0,
        revealed: false,
      };
      x++;
    }
  }

  // Reveal area around nest
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = Math.floor(nestPos.x) + dx;
      const ny = Math.floor(nestPos.y) + dy;
      if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
        tiles[ny][nx].revealed = true;
        tiles[ny][nx].homePheromone = Math.max(0.3, 1 - Math.abs(dx) * 0.2 - Math.abs(dy) * 0.2);
      }
    }
  }

  return { tiles, nestPos };
};

const createAnt = (nestPos: Vec2, id: number): Ant => {
  const angle = Math.random() * Math.PI * 2;
  return {
    id,
    pos: vec2.copy(nestPos),
    velocity: vec2.fromAngle(angle, ANT_MAX_SPEED * 0.5),
    state: "explore",
    carriedInfo: null,
    trail: [vec2.copy(nestPos)],
    isAlive: true,
    wanderAngle: angle,
    color: ANT_COLORS[id % ANT_COLORS.length],
    lastTrailSample: Date.now(),
  };
};

// Get tile at continuous position
const getTileAt = (map: Tile[][], pos: Vec2): Tile | null => {
  const tx = Math.floor(pos.x);
  const ty = Math.floor(pos.y);
  if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) return null;
  return map[ty][tx];
};

// Sample pheromone with bilinear interpolation for smooth gradients
const samplePheromone = (map: Tile[][], pos: Vec2, type: "food" | "home"): number => {
  const x = pos.x - 0.5;
  const y = pos.y - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;

  const getValue = (tx: number, ty: number): number => {
    if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) return 0;
    return type === "food" ? map[ty][tx].foodPheromone : map[ty][tx].homePheromone;
  };

  const v00 = getValue(x0, y0);
  const v10 = getValue(x1, y0);
  const v01 = getValue(x0, y1);
  const v11 = getValue(x1, y1);

  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
};

// Get pheromone gradient direction
const getPheromoneGradient = (map: Tile[][], pos: Vec2, type: "food" | "home"): Vec2 => {
  const delta = 0.3;
  const left = samplePheromone(map, { x: pos.x - delta, y: pos.y }, type);
  const right = samplePheromone(map, { x: pos.x + delta, y: pos.y }, type);
  const up = samplePheromone(map, { x: pos.x, y: pos.y - delta }, type);
  const down = samplePheromone(map, { x: pos.x, y: pos.y + delta }, type);

  return vec2.normalize({ x: right - left, y: down - up });
};

// ============================================
// STEERING BEHAVIORS
// ============================================

const steer = {
  // Seek a target position
  seek: (ant: Ant, target: Vec2, weight: number = 1): Vec2 => {
    const desired = vec2.sub(target, ant.pos);
    const desiredNorm = vec2.scale(vec2.normalize(desired), ANT_MAX_SPEED);
    const steerForce = vec2.sub(desiredNorm, ant.velocity);
    return vec2.scale(vec2.limit(steerForce, ANT_MAX_FORCE), weight);
  },

  // Flee from a position
  flee: (ant: Ant, target: Vec2, weight: number = 1): Vec2 => {
    return vec2.scale(steer.seek(ant, target, 1), -weight);
  },

  // Wander randomly but smoothly
  wander: (ant: Ant): { force: Vec2; newAngle: number } => {
    // Slowly drift the wander angle
    const newAngle = ant.wanderAngle + (Math.random() - 0.5) * ANT_WANDER_RATE * 2;

    // Project a circle in front of the ant
    const circleDistance = 1.5;
    const circleRadius = 0.8;

    const velocity = vec2.length(ant.velocity) > 0.001 ? ant.velocity : vec2.fromAngle(ant.wanderAngle, 0.01);
    const circleCenter = vec2.add(ant.pos, vec2.scale(vec2.normalize(velocity), circleDistance));

    // Point on circle
    const displacement = vec2.fromAngle(newAngle, circleRadius);
    const target = vec2.add(circleCenter, displacement);

    return {
      force: vec2.scale(steer.seek(ant, target, 1), ANT_WANDER_STRENGTH),
      newAngle,
    };
  },

  // Avoid borders
  avoidBorders: (ant: Ant, margin: number = 1.5): Vec2 => {
    const force = vec2.create(0, 0);
    const strength = 0.02;

    if (ant.pos.x < margin) {
      force.x += strength * (margin - ant.pos.x);
    }
    if (ant.pos.x > WORLD_SIZE - margin) {
      force.x -= strength * (ant.pos.x - (WORLD_SIZE - margin));
    }
    if (ant.pos.y < margin) {
      force.y += strength * (margin - ant.pos.y);
    }
    if (ant.pos.y > WORLD_SIZE - margin) {
      force.y -= strength * (ant.pos.y - (WORLD_SIZE - margin));
    }

    return force;
  },

  // Follow pheromone gradient
  followPheromone: (ant: Ant, map: Tile[][], type: "food" | "home", weight: number = 1): Vec2 => {
    const gradient = getPheromoneGradient(map, ant.pos, type);
    const strength = samplePheromone(map, ant.pos, type);

    if (strength < 0.01) return vec2.create(0, 0);

    const target = vec2.add(ant.pos, vec2.scale(gradient, 2));
    return vec2.scale(steer.seek(ant, target, 1), weight * Math.min(1, strength * 2));
  },
};

// ============================================
// CATMULL-ROM SPLINE FOR SMOOTH TRAILS
// ============================================

const catmullRomPoint = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
};

// ============================================
// CANVAS RENDERING
// ============================================

const worldToCanvas = (pos: Vec2): Vec2 => ({
  x: pos.x * TILE_SIZE,
  y: pos.y * TILE_SIZE,
});

const renderGame = (ctx: CanvasRenderingContext2D, gameState: GameState) => {
  const { map, ants, nestPos } = gameState;

  // Clear canvas with dark background
  ctx.fillStyle = "#1a1209";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Draw ground tiles
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;

      if (tile.type === "border") {
        ctx.fillStyle = "#0d0806";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        // Rocky texture
        ctx.fillStyle = "#1a1210";
        for (let i = 0; i < 3; i++) {
          const rx = px + 4 + Math.random() * (TILE_SIZE - 12);
          const ry = py + 4 + Math.random() * (TILE_SIZE - 12);
          ctx.beginPath();
          ctx.arc(rx, ry, 3 + Math.random() * 4, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (tile.revealed) {
        // Revealed earth - warm brown
        ctx.fillStyle = "#3d2817";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        // Subtle texture
        ctx.fillStyle = "#4a3020";
        ctx.fillRect(px + 2, py + 2, TILE_SIZE - 4, TILE_SIZE - 4);
      } else {
        // Fog - very dark
        ctx.fillStyle = "#0f0a06";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // Draw food pheromone as heat map
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (tile.foodPheromone > 0.02 && tile.revealed) {
        const px = x * TILE_SIZE + TILE_SIZE / 2;
        const py = y * TILE_SIZE + TILE_SIZE / 2;
        const intensity = Math.min(1, tile.foodPheromone);

        const gradient = ctx.createRadialGradient(px, py, 0, px, py, TILE_SIZE * 0.8);
        gradient.addColorStop(0, `rgba(100, 200, 100, ${intensity * 0.4})`);
        gradient.addColorStop(1, "rgba(100, 200, 100, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(x * TILE_SIZE - 8, y * TILE_SIZE - 8, TILE_SIZE + 16, TILE_SIZE + 16);
      }
    }
  }

  // Draw ant trails as smooth curves
  const aliveAnts = ants.filter(a => a.isAlive);

  for (const ant of aliveAnts) {
    const trail = ant.trail;
    if (trail.length < 3) continue;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Draw trail as Catmull-Rom spline segments
    for (let i = 0; i < trail.length - 1; i++) {
      const p0 = trail[Math.max(0, i - 1)];
      const p1 = trail[i];
      const p2 = trail[Math.min(trail.length - 1, i + 1)];
      const p3 = trail[Math.min(trail.length - 1, i + 2)];

      // Progress along trail (0 = oldest, 1 = newest)
      const progress = i / (trail.length - 1);

      // Fade out older parts of trail
      let alpha = progress;
      if (progress < TRAIL_FADE_START) {
        alpha = (progress / TRAIL_FADE_START) * 0.3;
      }
      alpha = Math.max(0.05, alpha);

      // Line width grows toward head
      const lineWidth = 1 + progress * 4;

      // Color based on state
      let color = ant.color;
      if (ant.carriedInfo === "food") {
        color = "#4CAF50";
      }

      // Parse hex color
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.lineWidth = lineWidth;

      // Draw smooth curve segment
      ctx.beginPath();
      const start = worldToCanvas(p1);
      ctx.moveTo(start.x, start.y);

      // Subdivide for smoothness
      const steps = 4;
      for (let t = 1; t <= steps; t++) {
        const point = catmullRomPoint(p0, p1, p2, p3, t / steps);
        const canvasPoint = worldToCanvas(point);
        ctx.lineTo(canvasPoint.x, canvasPoint.y);
      }
      ctx.stroke();
    }

    // Draw glowing head at current position
    const headPos = worldToCanvas(ant.pos);
    const gradient = ctx.createRadialGradient(headPos.x, headPos.y, 0, headPos.x, headPos.y, 12);
    let headColor = ant.color;
    if (ant.carriedInfo === "food") {
      headColor = "#4CAF50";
    }
    gradient.addColorStop(0, headColor);
    gradient.addColorStop(0.5, headColor + "80");
    gradient.addColorStop(1, headColor + "00");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(headPos.x, headPos.y, 12, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw nest
  const nestCanvas = worldToCanvas(nestPos);

  // Nest glow
  const nestGlow = ctx.createRadialGradient(nestCanvas.x, nestCanvas.y, 0, nestCanvas.x, nestCanvas.y, TILE_SIZE * 2.5);
  nestGlow.addColorStop(0, "rgba(180, 120, 60, 0.3)");
  nestGlow.addColorStop(0.5, "rgba(180, 120, 60, 0.1)");
  nestGlow.addColorStop(1, "rgba(180, 120, 60, 0)");
  ctx.fillStyle = nestGlow;
  ctx.beginPath();
  ctx.arc(nestCanvas.x, nestCanvas.y, TILE_SIZE * 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Nest mound
  ctx.fillStyle = "#5d4025";
  ctx.beginPath();
  ctx.arc(nestCanvas.x, nestCanvas.y, TILE_SIZE * 0.8, 0, Math.PI * 2);
  ctx.fill();

  // Nest hole
  ctx.fillStyle = "#1a0f0a";
  ctx.beginPath();
  ctx.ellipse(nestCanvas.x, nestCanvas.y + 4, TILE_SIZE * 0.35, TILE_SIZE * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Draw food
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (tile.type === "food" && tile.revealed) {
        const px = x * TILE_SIZE + TILE_SIZE / 2;
        const py = y * TILE_SIZE + TILE_SIZE / 2;

        // Glow
        ctx.shadowColor = "#4CAF50";
        ctx.shadowBlur = 15;

        // Berry/food
        ctx.fillStyle = "#c62828";
        ctx.beginPath();
        ctx.arc(px, py, TILE_SIZE * 0.35, 0, Math.PI * 2);
        ctx.fill();

        // Highlight
        ctx.fillStyle = "#ef5350";
        ctx.beginPath();
        ctx.arc(px - 4, py - 4, TILE_SIZE * 0.15, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
      }
    }
  }

  // Draw spiders
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (tile.type === "spider" && tile.revealed) {
        const px = x * TILE_SIZE + TILE_SIZE / 2;
        const py = y * TILE_SIZE + TILE_SIZE / 2;

        // Danger glow
        ctx.shadowColor = "#f44336";
        ctx.shadowBlur = 20;

        // Spider body
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath();
        ctx.ellipse(px, py, TILE_SIZE * 0.35, TILE_SIZE * 0.25, 0, 0, Math.PI * 2);
        ctx.fill();

        // Legs
        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          const angle = ((i - 1.5) * 0.5 * Math.PI) / 2;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.quadraticCurveTo(px - 15, py + Math.sin(angle) * 10, px - 20, py + (i - 1.5) * 8);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.quadraticCurveTo(px + 15, py + Math.sin(angle) * 10, px + 20, py + (i - 1.5) * 8);
          ctx.stroke();
        }

        // Eyes
        ctx.fillStyle = "#f44336";
        ctx.beginPath();
        ctx.arc(px - 4, py - 4, 3, 0, Math.PI * 2);
        ctx.arc(px + 4, py - 4, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
      }
    }
  }

  // Draw ants
  for (const ant of aliveAnts) {
    const pos = worldToCanvas(ant.pos);
    const angle = vec2.angle(ant.velocity);

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(angle);

    // Shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.beginPath();
    ctx.ellipse(2, 3, 10, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Glow
    ctx.shadowColor = ant.carriedInfo === "food" ? "#4CAF50" : ant.color;
    ctx.shadowBlur = 10;

    // Body
    ctx.fillStyle = "#0a0a0a";

    // Abdomen
    ctx.beginPath();
    ctx.ellipse(-10, 0, 7, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thorax
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Head
    ctx.beginPath();
    ctx.ellipse(8, 0, 4, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Antennae
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(10, -2);
    ctx.quadraticCurveTo(14, -8, 18, -6);
    ctx.moveTo(10, 2);
    ctx.quadraticCurveTo(14, 8, 18, 6);
    ctx.stroke();

    // Legs
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const legX = 4 - i * 5;
      ctx.beginPath();
      ctx.moveTo(legX, -3);
      ctx.quadraticCurveTo(legX + 2, -10, legX + 6, -12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(legX, 3);
      ctx.quadraticCurveTo(legX + 2, 10, legX + 6, 12);
      ctx.stroke();
    }

    // Food indicator
    if (ant.carriedInfo === "food") {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#4CAF50";
      ctx.beginPath();
      ctx.arc(-8, 0, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.shadowBlur = 0;
  }

  // Draw fog of war soft edges
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (!tile.revealed && tile.type !== "border") {
        // Check for revealed neighbors
        let hasRevealedNeighbor = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
              if (map[ny][nx].revealed) hasRevealedNeighbor = true;
            }
          }
        }

        if (hasRevealedNeighbor) {
          const px = x * TILE_SIZE + TILE_SIZE / 2;
          const py = y * TILE_SIZE + TILE_SIZE / 2;

          const gradient = ctx.createRadialGradient(px, py, 0, px, py, TILE_SIZE * 1.2);
          gradient.addColorStop(0, "rgba(15, 10, 6, 0.9)");
          gradient.addColorStop(0.5, "rgba(15, 10, 6, 0.5)");
          gradient.addColorStop(1, "rgba(15, 10, 6, 0)");
          ctx.fillStyle = gradient;
          ctx.fillRect(x * TILE_SIZE - TILE_SIZE, y * TILE_SIZE - TILE_SIZE, TILE_SIZE * 3, TILE_SIZE * 3);
        }
      }
    }
  }
};

// ============================================
// GAME COMPONENT
// ============================================

const Home: NextPage = () => {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [gameSpeed, setGameSpeed] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const gameTickRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize game
  const initGame = useCallback(() => {
    const { tiles, nestPos } = parseMapTemplate();
    const ants: Ant[] = [];
    for (let i = 0; i < INITIAL_ANTS; i++) {
      ants.push(createAnt(nestPos, i));
    }

    setGameState({
      map: tiles,
      ants,
      directive: "explore",
      food: INITIAL_FOOD,
      maxFood: WIN_FOOD,
      tick: 0,
      gameOver: false,
      won: false,
      ticksSinceLastFood: 0,
      nestPos,
      antIdCounter: INITIAL_ANTS,
    });
    setIsPaused(false);
  }, []);

  // Physics update (runs every frame)
  const updatePhysics = useCallback(
    (state: GameState): GameState => {
      if (state.gameOver || isPaused) return state;

      const now = Date.now();
      const newAnts = state.ants.map(ant => {
        if (!ant.isAlive) return ant;

        const newAnt = { ...ant };
        let totalForce = vec2.create(0, 0);

        // State-based behavior
        switch (ant.state) {
          case "explore": {
            // Wander + move away from nest + avoid borders
            const { force: wanderForce, newAngle } = steer.wander(ant);
            totalForce = vec2.add(totalForce, wanderForce);
            newAnt.wanderAngle = newAngle;

            // Bias away from nest when exploring
            const distToNest = vec2.distance(ant.pos, state.nestPos);
            if (distToNest < 6) {
              const awayFromNest = steer.flee(ant, state.nestPos, 0.5);
              totalForce = vec2.add(totalForce, awayFromNest);
            }

            // If there's food pheromone nearby, follow it a bit
            const foodPher = samplePheromone(state.map, ant.pos, "food");
            if (foodPher > 0.05) {
              const followFood = steer.followPheromone(ant, state.map, "food", 0.3);
              totalForce = vec2.add(totalForce, followFood);
            }
            break;
          }

          case "harvest": {
            // Follow food pheromone trail
            const foodPher = samplePheromone(state.map, ant.pos, "food");
            if (foodPher > 0.02) {
              const followFood = steer.followPheromone(ant, state.map, "food", 1.5);
              totalForce = vec2.add(totalForce, followFood);
            } else {
              // No trail - wander near nest
              const { force: wanderForce, newAngle } = steer.wander(ant);
              totalForce = vec2.add(totalForce, vec2.scale(wanderForce, 0.5));
              newAnt.wanderAngle = newAngle;

              // Stay somewhat close to nest
              const distToNest = vec2.distance(ant.pos, state.nestPos);
              if (distToNest > 4) {
                const toNest = steer.seek(ant, state.nestPos, 0.3);
                totalForce = vec2.add(totalForce, toNest);
              }
            }

            // Light wander to avoid getting stuck
            const { force: lightWander, newAngle } = steer.wander(ant);
            totalForce = vec2.add(totalForce, vec2.scale(lightWander, 0.2));
            newAnt.wanderAngle = newAngle;
            break;
          }

          case "return": {
            // Head back to nest, following home pheromone
            const toNest = steer.seek(ant, state.nestPos, 1.2);
            totalForce = vec2.add(totalForce, toNest);

            // Also follow home pheromone
            const followHome = steer.followPheromone(ant, state.map, "home", 0.4);
            totalForce = vec2.add(totalForce, followHome);
            break;
          }

          case "defend": {
            // Stay near nest, patrol
            const distToNest = vec2.distance(ant.pos, state.nestPos);
            if (distToNest > 2.5) {
              const toNest = steer.seek(ant, state.nestPos, 1);
              totalForce = vec2.add(totalForce, toNest);
            } else {
              // Patrol around nest
              const { force: wanderForce, newAngle } = steer.wander(ant);
              totalForce = vec2.add(totalForce, wanderForce);
              newAnt.wanderAngle = newAngle;
            }
            break;
          }
        }

        // Always avoid borders
        const borderForce = steer.avoidBorders(ant);
        totalForce = vec2.add(totalForce, borderForce);

        // Apply steering force
        totalForce = vec2.limit(totalForce, ANT_MAX_FORCE);
        newAnt.velocity = vec2.add(ant.velocity, totalForce);
        newAnt.velocity = vec2.limit(newAnt.velocity, ANT_MAX_SPEED);

        // Update position
        newAnt.pos = vec2.add(ant.pos, newAnt.velocity);

        // Clamp to world bounds
        newAnt.pos.x = Math.max(1.2, Math.min(WORLD_SIZE - 1.2, newAnt.pos.x));
        newAnt.pos.y = Math.max(1.2, Math.min(WORLD_SIZE - 1.2, newAnt.pos.y));

        // Sample trail position periodically
        if (now - ant.lastTrailSample > TRAIL_SAMPLE_INTERVAL) {
          newAnt.trail = [...ant.trail, vec2.copy(newAnt.pos)];
          if (newAnt.trail.length > TRAIL_MAX_LENGTH) {
            newAnt.trail = newAnt.trail.slice(-TRAIL_MAX_LENGTH);
          }
          newAnt.lastTrailSample = now;
        }

        return newAnt;
      });

      return { ...state, ants: newAnts };
    },
    [isPaused],
  );

  // Game logic tick (runs at slower interval)
  const gameTick = useCallback(() => {
    setGameState(prev => {
      if (!prev || prev.gameOver) return prev;

      // Decay pheromones
      const newMap = prev.map.map(row =>
        row.map(tile => ({
          ...tile,
          homePheromone: Math.max(0, tile.homePheromone - PHEROMONE_DECAY),
          foodPheromone: Math.max(0, tile.foodPheromone - PHEROMONE_DECAY),
        })),
      );

      // Reinforce nest area
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = Math.floor(prev.nestPos.x) + dx;
          const ny = Math.floor(prev.nestPos.y) + dy;
          if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
            newMap[ny][nx].homePheromone = Math.max(
              newMap[ny][nx].homePheromone,
              0.8 - Math.abs(dx) * 0.15 - Math.abs(dy) * 0.15,
            );
          }
        }
      }

      let newFood = prev.food;
      let ticksSinceLastFood = prev.ticksSinceLastFood + 1;
      let antIdCounter = prev.antIdCounter;
      const newAntsToSpawn: Ant[] = [];

      // Process ants
      const newAnts = prev.ants.map(ant => {
        if (!ant.isAlive) return ant;

        const newAnt = { ...ant };
        const tile = getTileAt(newMap, ant.pos);

        if (!tile) return newAnt;

        // Reveal tiles as ant moves
        const tx = Math.floor(ant.pos.x);
        const ty = Math.floor(ant.pos.y);
        if (tx >= 0 && tx < MAP_SIZE && ty >= 0 && ty < MAP_SIZE) {
          // Deposit pheromones
          if (ant.carriedInfo === "food") {
            newMap[ty][tx].foodPheromone = Math.min(1, newMap[ty][tx].foodPheromone + PHEROMONE_DEPOSIT_RATE);
          }
          newMap[ty][tx].homePheromone = Math.min(1, newMap[ty][tx].homePheromone + PHEROMONE_DEPOSIT_RATE * 0.3);
        }

        // Check for spider collision
        if (tile.type === "spider") {
          newAnt.isAlive = false;
          return newAnt;
        }

        // Check for food pickup
        if (tile.type === "food" && ant.carriedInfo === null && (ant.state === "explore" || ant.state === "harvest")) {
          newAnt.carriedInfo = "food";
          newAnt.state = "return";
          newMap[ty][tx].foodPheromone = 1; // Strong marker at food source
        }

        // Check for nest arrival with food
        const distToNest = vec2.distance(ant.pos, prev.nestPos);
        if (distToNest < 1 && ant.carriedInfo === "food") {
          newFood += 1;
          ticksSinceLastFood = 0;
          newAnt.carriedInfo = null;

          // Reveal ant's trail
          for (const trailPos of ant.trail) {
            const trailTx = Math.floor(trailPos.x);
            const trailTy = Math.floor(trailPos.y);
            if (trailTx >= 0 && trailTx < MAP_SIZE && trailTy >= 0 && trailTy < MAP_SIZE) {
              newMap[trailTy][trailTx].revealed = true;
            }
          }

          // Reset trail and continue based on directive
          newAnt.trail = [vec2.copy(prev.nestPos)];
          newAnt.state = prev.directive === "defend" ? "defend" : prev.directive === "harvest" ? "harvest" : "explore";
        }

        // Non-carrying ants at nest can switch state based on directive
        if (distToNest < 1 && ant.carriedInfo === null && ant.state === "return") {
          newAnt.trail = [vec2.copy(prev.nestPos)];
          newAnt.state = prev.directive;
        }

        return newAnt;
      });

      // Spawn new ants
      const aliveAnts = newAnts.filter(a => a.isAlive);
      if (newFood >= SPAWN_FOOD_COST && aliveAnts.length < MAX_ANTS) {
        newFood -= SPAWN_FOOD_COST;
        newAntsToSpawn.push(createAnt(prev.nestPos, antIdCounter));
        antIdCounter++;
      }

      const allAnts = [...newAnts, ...newAntsToSpawn];
      const finalAliveAnts = allAnts.filter(a => a.isAlive);

      // Check win/lose
      let gameOver = false;
      let won = false;

      if (newFood >= WIN_FOOD) {
        gameOver = true;
        won = true;
      } else if (finalAliveAnts.length < MIN_ANTS_TO_SURVIVE) {
        gameOver = true;
        won = false;
      } else if (ticksSinceLastFood > STARVATION_TICKS) {
        gameOver = true;
        won = false;
      }

      return {
        ...prev,
        map: newMap,
        ants: allAnts,
        food: newFood,
        tick: prev.tick + 1,
        gameOver,
        won,
        ticksSinceLastFood,
        antIdCounter,
      };
    });
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const animate = () => {
      // Update physics ~60fps
      if (gameState && !gameState.gameOver && !isPaused) {
        setGameState(prev => (prev ? updatePhysics(prev) : prev));
      }

      // Render
      if (gameState) {
        renderGame(ctx, gameState);
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [gameState, isPaused, updatePhysics]);

  // Initialize
  useEffect(() => {
    initGame();
  }, [initGame]);

  // Game logic tick
  useEffect(() => {
    if (gameState && !gameState.gameOver && !isPaused) {
      gameTickRef.current = setInterval(gameTick, GAME_TICK_INTERVAL / gameSpeed);
    }
    return () => {
      if (gameTickRef.current) clearInterval(gameTickRef.current);
    };
  }, [gameState?.gameOver, isPaused, gameSpeed, gameTick]);

  const setDirective = (directive: GlobalDirective) => {
    setGameState(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        directive,
        ants: prev.ants.map(ant => ({
          ...ant,
          state: ant.state === "return" ? "return" : directive,
        })),
      };
    });
  };

  if (!gameState) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stone-900">
        <div className="text-2xl text-amber-200">Loading...</div>
      </div>
    );
  }

  const aliveAnts = gameState.ants.filter(a => a.isAlive);

  return (
    <div className="flex flex-col items-center min-h-screen bg-gradient-to-b from-stone-900 via-stone-800 to-stone-900 text-white p-4">
      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-4xl font-bold mb-2 text-amber-200" style={{ fontFamily: "serif" }}>
          🐜 Ant Colony 🐜
        </h1>
        <p className="text-amber-100/80 text-sm max-w-md">Watch your ants explore with smooth, organic movement</p>
      </div>

      {/* Stats Bar */}
      <div className="flex gap-6 mb-4 bg-stone-800/80 rounded-lg px-6 py-3 border border-stone-700">
        <div className="text-center">
          <div className="text-2xl font-bold text-green-400">
            {gameState.food}/{WIN_FOOD}
          </div>
          <div className="text-xs text-amber-200/60">FOOD</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-amber-400">{aliveAnts.length}</div>
          <div className="text-xs text-amber-200/60">ANTS</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-red-400">
            {gameState.ticksSinceLastFood > 50 ? `⚠️ ${STARVATION_TICKS - gameState.ticksSinceLastFood}` : "—"}
          </div>
          <div className="text-xs text-amber-200/60">STARVE IN</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-blue-400">{gameState.tick}</div>
          <div className="text-xs text-amber-200/60">TICK</div>
        </div>
      </div>

      {/* Game Over Screen */}
      {gameState.gameOver && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-stone-800 rounded-xl p-8 text-center border border-stone-600">
            <h2 className={`text-4xl font-bold mb-4 ${gameState.won ? "text-green-400" : "text-red-400"}`}>
              {gameState.won ? "🎉 VICTORY! 🎉" : "💀 COLONY LOST 💀"}
            </h2>
            <p className="text-amber-200/80 mb-4">
              {gameState.won
                ? `You gathered ${WIN_FOOD} food and secured the colony!`
                : aliveAnts.length < MIN_ANTS_TO_SURVIVE
                  ? "Too many ants perished in the darkness..."
                  : "The colony starved..."}
            </p>
            <button onClick={initGame} className="btn btn-lg bg-amber-600 hover:bg-amber-500 text-white border-none">
              Play Again
            </button>
          </div>
        </div>
      )}

      {/* Control Buttons */}
      <div className="flex gap-3 mb-4">
        <button
          onClick={() => setDirective("explore")}
          className={`btn btn-lg ${gameState.directive === "explore" ? "bg-blue-600 ring-2 ring-blue-300" : "bg-stone-700"} hover:bg-blue-500 text-white border-none`}
        >
          🧭 Explore
        </button>
        <button
          onClick={() => setDirective("harvest")}
          className={`btn btn-lg ${gameState.directive === "harvest" ? "bg-green-600 ring-2 ring-green-300" : "bg-stone-700"} hover:bg-green-500 text-white border-none`}
        >
          🌾 Harvest
        </button>
        <button
          onClick={() => setDirective("defend")}
          className={`btn btn-lg ${gameState.directive === "defend" ? "bg-orange-600 ring-2 ring-orange-300" : "bg-stone-700"} hover:bg-orange-500 text-white border-none`}
        >
          🛡️ Defend
        </button>
      </div>

      {/* Directive Info */}
      <div className="text-center mb-4 text-sm text-amber-200/70">
        {gameState.directive === "explore" && "Ants wander outward exploring the unknown."}
        {gameState.directive === "harvest" && "Ants follow pheromone trails to known food."}
        {gameState.directive === "defend" && "Ants stay close to the nest."}
      </div>

      {/* Game Canvas */}
      <div className="rounded-lg overflow-hidden shadow-2xl border-2 border-stone-700">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{
            width: `min(${CANVAS_SIZE}px, 90vw)`,
            height: `min(${CANVAS_SIZE}px, 90vw)`,
          }}
        />
      </div>

      {/* Speed & Pause Controls */}
      <div className="flex gap-3 mt-4">
        <button
          onClick={() => setIsPaused(!isPaused)}
          className="btn bg-stone-700 hover:bg-stone-600 text-white border-none"
        >
          {isPaused ? "▶️ Resume" : "⏸️ Pause"}
        </button>
        <button
          onClick={() => setGameSpeed(gameSpeed === 0.5 ? 1 : gameSpeed === 1 ? 2 : 0.5)}
          className="btn bg-stone-700 hover:bg-stone-600 text-white border-none"
        >
          ⚡ {gameSpeed}x
        </button>
        <button onClick={initGame} className="btn bg-red-800 hover:bg-red-700 text-white border-none">
          🔄 Restart
        </button>
      </div>

      {/* Legend */}
      <div className="mt-6 text-xs text-amber-200/60 max-w-lg">
        <div className="flex flex-wrap justify-center gap-4">
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-amber-700"></span>
            Nest
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-stone-900 border border-stone-500"></span>
            Ant
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-red-600"></span>
            Food
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-stone-900 border border-red-500"></span>
            Spider
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-stone-950"></span>
            Fog
          </span>
          <span className="flex items-center gap-2">
            <span
              className="w-4 h-4 rounded"
              style={{ background: "linear-gradient(90deg, #FF6B6B55, #FF6B6B)" }}
            ></span>
            Trail
          </span>
        </div>
      </div>

      <p className="mt-4 text-amber-200/40 text-xs">
        Smooth steering behaviors • Catmull-Rom spline trails • Real-time physics
      </p>
    </div>
  );
};

export default Home;
