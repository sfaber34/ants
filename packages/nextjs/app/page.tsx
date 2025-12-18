"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NextPage } from "next";

// ============================================
// TYPES
// ============================================

type TileType = "ground" | "border" | "food" | "spider" | "nest";
type AntState = "explore" | "return" | "harvest" | "defend";
type GlobalDirective = "explore" | "harvest" | "defend";

interface Position {
  x: number;
  y: number;
}

interface Ant {
  id: number;
  pos: Position;
  prevPos: Position; // For smooth interpolation
  state: AntState;
  carriedInfo: "food" | "danger" | null;
  trailHistory: Position[];
  trailIndex: number;
  heading: Position;
  isAlive: boolean;
  ticksSinceSpawn: number;
  color: string; // Unique color for each ant's trail
}

interface Tile {
  type: TileType;
  homePheromone: number;
  foodPheromone: number;
  revealed: boolean;
  hasTrail: boolean;
  trailStrength: number;
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
  nestPos: Position;
  antIdCounter: number;
}

// ============================================
// CONSTANTS
// ============================================

const MAP_SIZE = 20;
const TILE_SIZE = 32; // Pixels per tile
const CANVAS_SIZE = MAP_SIZE * TILE_SIZE;
const PHEROMONE_DECAY = 0.005;
const TRAIL_DECAY = 0.003;
const MAX_ANTS = 15;
const INITIAL_ANTS = 2;
const INITIAL_FOOD = 5;
const WIN_FOOD = 30;
const STARVATION_TICKS = 300;
const MIN_ANTS_TO_SURVIVE = 1;
const SPAWN_FOOD_COST = 5;
const TICK_INTERVAL = 1200;

// Ant colors for unique trail visualization
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
// HELPER FUNCTIONS
// ============================================

const parseMapTemplate = (): { tiles: Tile[][]; nestPos: Position } => {
  let nestPos: Position = { x: 10, y: 18 };
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
        nestPos = { x, y };
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
        hasTrail: false,
        trailStrength: 0,
      };
      x++;
    }

    while (x < MAP_SIZE) {
      tiles[y][x] = {
        type: "ground",
        homePheromone: 0,
        foodPheromone: 0,
        revealed: false,
        hasTrail: false,
        trailStrength: 0,
      };
      x++;
    }
  }

  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = nestPos.x + dx;
      const ny = nestPos.y + dy;
      if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
        tiles[ny][nx].revealed = true;
        tiles[ny][nx].homePheromone = Math.max(0.3, 1 - Math.abs(dx) * 0.2 - Math.abs(dy) * 0.2);
      }
    }
  }

  return { tiles, nestPos };
};

const randomHeading = (nestPos: Position): Position => {
  const angle = Math.random() * Math.PI * 2;
  return {
    x: Math.round(Math.cos(angle) * 10) + nestPos.x,
    y: Math.round(Math.sin(angle) * 10) + nestPos.y,
  };
};

const createInitialAnts = (nestPos: Position, count: number, startId: number): Ant[] => {
  const ants: Ant[] = [];
  for (let i = 0; i < count; i++) {
    ants.push({
      id: startId + i,
      pos: { ...nestPos },
      prevPos: { ...nestPos },
      state: "explore",
      carriedInfo: null,
      trailHistory: [{ ...nestPos }],
      trailIndex: 0,
      heading: randomHeading(nestPos),
      isAlive: true,
      ticksSinceSpawn: 0,
      color: ANT_COLORS[i % ANT_COLORS.length],
    });
  }
  return ants;
};

const distance = (a: Position, b: Position): number => {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
};

const getNeighbors = (pos: Position): Position[] => {
  const dirs = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 },
  ];
  return dirs
    .map(d => ({ x: pos.x + d.x, y: pos.y + d.y }))
    .filter(p => p.x >= 0 && p.x < MAP_SIZE && p.y >= 0 && p.y < MAP_SIZE);
};

// Convert grid position to canvas pixel position (center of tile)
const toPixel = (pos: Position): { x: number; y: number } => ({
  x: pos.x * TILE_SIZE + TILE_SIZE / 2,
  y: pos.y * TILE_SIZE + TILE_SIZE / 2,
});

// ============================================
// CANVAS RENDERING
// ============================================

const renderGame = (ctx: CanvasRenderingContext2D, gameState: GameState, interpolation: number) => {
  const { map, ants, nestPos } = gameState;

  // Clear canvas
  ctx.fillStyle = "#2D1B0E";
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Draw ground tiles and borders
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;

      if (tile.type === "border") {
        // Rocky border
        ctx.fillStyle = "#1a0f0a";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        // Add some texture
        ctx.fillStyle = "#2a1f1a";
        ctx.fillRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8);
      } else if (tile.revealed) {
        // Revealed ground - lighter brown
        ctx.fillStyle = "#5D4037";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      } else {
        // Fog of war - dark
        ctx.fillStyle = "#1E1E1E";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // Draw subtle grid lines on revealed areas
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= MAP_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(i * TILE_SIZE, 0);
    ctx.lineTo(i * TILE_SIZE, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * TILE_SIZE);
    ctx.lineTo(CANVAS_SIZE, i * TILE_SIZE);
    ctx.stroke();
  }

  // Draw food pheromone trails (heat map style)
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (tile.foodPheromone > 0.05 && tile.revealed) {
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;
        const intensity = Math.min(1, tile.foodPheromone);

        // Green glow for food pheromone
        const gradient = ctx.createRadialGradient(
          px + TILE_SIZE / 2,
          py + TILE_SIZE / 2,
          0,
          px + TILE_SIZE / 2,
          py + TILE_SIZE / 2,
          TILE_SIZE * 0.7,
        );
        gradient.addColorStop(0, `rgba(76, 175, 80, ${intensity * 0.6})`);
        gradient.addColorStop(1, `rgba(76, 175, 80, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(px - 4, py - 4, TILE_SIZE + 8, TILE_SIZE + 8);
      }
    }
  }

  // Draw ant trails as continuous lines
  const aliveAnts = ants.filter(a => a.isAlive);

  for (const ant of aliveAnts) {
    if (ant.trailHistory.length < 2) continue;

    ctx.beginPath();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const trail = ant.trailHistory;
    const startPixel = toPixel(trail[0]);
    ctx.moveTo(startPixel.x, startPixel.y);

    // Draw trail with gradient opacity (older = more transparent)
    for (let i = 1; i < trail.length; i++) {
      const pixel = toPixel(trail[i]);

      // Calculate opacity based on position in trail (newer = brighter)
      const progress = i / trail.length;
      const alpha = 0.1 + progress * 0.5;

      // Different colors based on ant state
      let trailColor = ant.color;
      if (ant.carriedInfo === "food") {
        trailColor = "#4CAF50"; // Green when carrying food
      }

      ctx.strokeStyle = trailColor.replace(")", `, ${alpha})`).replace("rgb", "rgba").replace("#", "");
      // Convert hex to rgba
      if (trailColor.startsWith("#")) {
        const r = parseInt(trailColor.slice(1, 3), 16);
        const g = parseInt(trailColor.slice(3, 5), 16);
        const b = parseInt(trailColor.slice(5, 7), 16);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }

      ctx.lineWidth = 2 + progress * 3;
      ctx.lineTo(pixel.x, pixel.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pixel.x, pixel.y);
    }
  }

  // Draw white trails on unrevealed tiles (scouting trails)
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (!tile.revealed && tile.hasTrail && tile.trailStrength > 0.05) {
        const px = x * TILE_SIZE + TILE_SIZE / 2;
        const py = y * TILE_SIZE + TILE_SIZE / 2;
        const intensity = Math.min(1, tile.trailStrength);

        // White dot for unexplored trail
        ctx.beginPath();
        ctx.arc(px, py, 3 + intensity * 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${intensity * 0.6})`;
        ctx.fill();
      }
    }
  }

  // Draw nest with glow effect
  const nestPixel = toPixel(nestPos);

  // Outer glow
  const nestGlow = ctx.createRadialGradient(nestPixel.x, nestPixel.y, 0, nestPixel.x, nestPixel.y, TILE_SIZE * 2);
  nestGlow.addColorStop(0, "rgba(139, 90, 43, 0.4)");
  nestGlow.addColorStop(1, "rgba(139, 90, 43, 0)");
  ctx.fillStyle = nestGlow;
  ctx.beginPath();
  ctx.arc(nestPixel.x, nestPixel.y, TILE_SIZE * 2, 0, Math.PI * 2);
  ctx.fill();

  // Nest body
  ctx.fillStyle = "#8B5A2B";
  ctx.beginPath();
  ctx.arc(nestPixel.x, nestPixel.y, TILE_SIZE * 0.6, 0, Math.PI * 2);
  ctx.fill();

  // Nest entrance
  ctx.fillStyle = "#3E2723";
  ctx.beginPath();
  ctx.ellipse(nestPixel.x, nestPixel.y + 4, TILE_SIZE * 0.25, TILE_SIZE * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();

  // Draw food sources
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (tile.type === "food" && tile.revealed) {
        const px = x * TILE_SIZE + TILE_SIZE / 2;
        const py = y * TILE_SIZE + TILE_SIZE / 2;

        // Food glow
        ctx.shadowColor = "#4CAF50";
        ctx.shadowBlur = 10;

        // Apple shape
        ctx.fillStyle = "#E53935";
        ctx.beginPath();
        ctx.arc(px, py + 2, TILE_SIZE * 0.35, 0, Math.PI * 2);
        ctx.fill();

        // Leaf
        ctx.fillStyle = "#4CAF50";
        ctx.beginPath();
        ctx.ellipse(px + 4, py - 8, 6, 3, Math.PI / 4, 0, Math.PI * 2);
        ctx.fill();

        // Stem
        ctx.strokeStyle = "#5D4037";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py - 4);
        ctx.lineTo(px + 2, py - 10);
        ctx.stroke();

        ctx.shadowBlur = 0;
      }
    }
  }

  // Draw spiders (danger)
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (tile.type === "spider" && tile.revealed) {
        const px = x * TILE_SIZE + TILE_SIZE / 2;
        const py = y * TILE_SIZE + TILE_SIZE / 2;

        // Danger glow
        ctx.shadowColor = "#F44336";
        ctx.shadowBlur = 15;

        // Spider body
        ctx.fillStyle = "#212121";
        ctx.beginPath();
        ctx.ellipse(px, py, TILE_SIZE * 0.3, TILE_SIZE * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();

        // Spider head
        ctx.beginPath();
        ctx.arc(px + TILE_SIZE * 0.25, py, TILE_SIZE * 0.15, 0, Math.PI * 2);
        ctx.fill();

        // Legs
        ctx.strokeStyle = "#212121";
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          const angle = (i - 1.5) * 0.4;
          // Left legs
          ctx.beginPath();
          ctx.moveTo(px - 4, py);
          ctx.quadraticCurveTo(px - 12, py + Math.sin(angle) * 8, px - 16, py + (i - 1.5) * 6);
          ctx.stroke();
          // Right legs
          ctx.beginPath();
          ctx.moveTo(px + 4, py);
          ctx.quadraticCurveTo(px + 12, py + Math.sin(angle) * 8, px + 16, py + (i - 1.5) * 6);
          ctx.stroke();
        }

        // Red eyes
        ctx.fillStyle = "#F44336";
        ctx.beginPath();
        ctx.arc(px + TILE_SIZE * 0.28, py - 3, 2, 0, Math.PI * 2);
        ctx.arc(px + TILE_SIZE * 0.28, py + 3, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
      }
    }
  }

  // Draw ants with smooth interpolation
  for (const ant of aliveAnts) {
    // Interpolate position for smooth movement
    const currentPixel = toPixel(ant.pos);
    const prevPixel = toPixel(ant.prevPos);
    const lerpX = prevPixel.x + (currentPixel.x - prevPixel.x) * interpolation;
    const lerpY = prevPixel.y + (currentPixel.y - prevPixel.y) * interpolation;

    // Ant shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.beginPath();
    ctx.ellipse(lerpX + 2, lerpY + 4, 8, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ant body color based on state
    const bodyColor = "#1a1a1a";
    let glowColor = ant.color;

    if (ant.carriedInfo === "food") {
      glowColor = "#4CAF50";
    }

    // Glow effect
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 8;

    // Ant body (3 segments)
    ctx.fillStyle = bodyColor;

    // Calculate heading direction for rotation
    const dx = ant.pos.x - ant.prevPos.x;
    const dy = ant.pos.y - ant.prevPos.y;
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.translate(lerpX, lerpY);
    ctx.rotate(angle);

    // Head
    ctx.beginPath();
    ctx.ellipse(8, 0, 4, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thorax
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Abdomen
    ctx.beginPath();
    ctx.ellipse(-9, 0, 6, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Antennae
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(10, -2);
    ctx.quadraticCurveTo(14, -6, 16, -4);
    ctx.moveTo(10, 2);
    ctx.quadraticCurveTo(14, 6, 16, 4);
    ctx.stroke();

    // Legs
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const legX = 3 - i * 4;
      // Top legs
      ctx.beginPath();
      ctx.moveTo(legX, -3);
      ctx.quadraticCurveTo(legX + 2, -8, legX + 4, -10);
      ctx.stroke();
      // Bottom legs
      ctx.beginPath();
      ctx.moveTo(legX, 3);
      ctx.quadraticCurveTo(legX + 2, 8, legX + 4, 10);
      ctx.stroke();
    }

    // Food indicator (green dot on back)
    if (ant.carriedInfo === "food") {
      ctx.fillStyle = "#4CAF50";
      ctx.beginPath();
      ctx.arc(-6, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.shadowBlur = 0;
  }

  // Draw fog of war edges (softer transition)
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const tile = map[y][x];
      if (!tile.revealed && tile.type !== "border") {
        // Check if adjacent to revealed tile
        const neighbors = getNeighbors({ x, y });
        const hasRevealedNeighbor = neighbors.some(n => map[n.y]?.[n.x]?.revealed);

        if (hasRevealedNeighbor) {
          const px = x * TILE_SIZE;
          const py = y * TILE_SIZE;

          // Soft fog edge
          const gradient = ctx.createRadialGradient(
            px + TILE_SIZE / 2,
            py + TILE_SIZE / 2,
            0,
            px + TILE_SIZE / 2,
            py + TILE_SIZE / 2,
            TILE_SIZE,
          );
          gradient.addColorStop(0, "rgba(30, 30, 30, 0.8)");
          gradient.addColorStop(1, "rgba(30, 30, 30, 0)");
          ctx.fillStyle = gradient;
          ctx.fillRect(px - TILE_SIZE / 2, py - TILE_SIZE / 2, TILE_SIZE * 2, TILE_SIZE * 2);
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
  const tickRef = useRef<NodeJS.Timeout | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastTickTime = useRef<number>(Date.now());

  // Initialize game
  const initGame = useCallback(() => {
    const { tiles, nestPos } = parseMapTemplate();
    const ants = createInitialAnts(nestPos, INITIAL_ANTS, 0);

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
    lastTickTime.current = Date.now();
  }, []);

  // Game tick logic (unchanged from original)
  const gameTick = useCallback(() => {
    setGameState(prev => {
      if (!prev || prev.gameOver) return prev;

      const newMap = prev.map.map(row =>
        row.map(tile => ({
          ...tile,
          homePheromone: Math.max(0, tile.homePheromone - PHEROMONE_DECAY),
          foodPheromone: Math.max(0, tile.foodPheromone - PHEROMONE_DECAY),
          trailStrength: Math.max(0, tile.trailStrength - TRAIL_DECAY),
          hasTrail: tile.trailStrength > TRAIL_DECAY,
        })),
      );

      // Keep nest pheromone strong
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = prev.nestPos.x + dx;
          const ny = prev.nestPos.y + dy;
          if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
            newMap[ny][nx].homePheromone = Math.max(
              newMap[ny][nx].homePheromone,
              1 - Math.abs(dx) * 0.15 - Math.abs(dy) * 0.15,
            );
          }
        }
      }

      let newFood = prev.food;
      let ticksSinceLastFood = prev.ticksSinceLastFood + 1;
      let antIdCounter = prev.antIdCounter;
      const newAntsToSpawn: Ant[] = [];

      // Process each ant
      const newAnts = prev.ants
        .filter(ant => ant.isAlive)
        .map(ant => {
          const newAnt = {
            ...ant,
            ticksSinceSpawn: ant.ticksSinceSpawn + 1,
            prevPos: { ...ant.pos }, // Store previous position for interpolation
          };
          const currentTile = newMap[ant.pos.y][ant.pos.x];

          // Deposit trail
          newMap[ant.pos.y][ant.pos.x] = {
            ...currentTile,
            hasTrail: true,
            trailStrength: Math.min(1, currentTile.trailStrength + 0.3),
          };

          // If carrying food, deposit pheromone
          if (ant.carriedInfo === "food") {
            newMap[ant.pos.y][ant.pos.x].foodPheromone = Math.min(1, newMap[ant.pos.y][ant.pos.x].foodPheromone + 0.5);
          }

          // Check if at nest and carrying info - DELIVER FOOD
          if (distance(ant.pos, prev.nestPos) <= 1 && ant.carriedInfo === "food") {
            newFood += 1;
            ticksSinceLastFood = 0;
            newAnt.carriedInfo = null;

            // Reveal the ant's trail
            ant.trailHistory.forEach(pos => {
              newMap[pos.y][pos.x].revealed = true;
            });

            newMap[prev.nestPos.y][prev.nestPos.x].foodPheromone = Math.min(
              1,
              newMap[prev.nestPos.y][prev.nestPos.x].foodPheromone + 0.3,
            );

            newAnt.trailHistory = [{ ...prev.nestPos }];
            newAnt.trailIndex = 0;

            if (prev.directive === "defend") {
              newAnt.state = "defend";
            } else if (prev.directive === "harvest") {
              newAnt.state = "harvest";
            } else {
              newAnt.state = "explore";
            }
          }

          // State machine
          const neighbors = getNeighbors(ant.pos);
          const validNeighbors = neighbors.filter(p => newMap[p.y][p.x].type !== "border");

          if (validNeighbors.length === 0) {
            return newAnt;
          }

          let targetPos: Position | null = null;

          switch (newAnt.state) {
            case "explore": {
              const visitedSet = new Set(ant.trailHistory.map(pos => `${pos.x},${pos.y}`));
              const unvisitedNeighbors = validNeighbors.filter(p => !visitedSet.has(`${p.x},${p.y}`));

              if (unvisitedNeighbors.length > 0) {
                const weights = unvisitedNeighbors.map(p => {
                  const tile = newMap[p.y][p.x];
                  let weight = 1;

                  const currentDistFromNest = distance(ant.pos, prev.nestPos);
                  const newDistFromNest = distance(p, prev.nestPos);
                  if (newDistFromNest > currentDistFromNest) {
                    weight += 10;
                  } else if (newDistFromNest < currentDistFromNest) {
                    weight *= 0.3;
                  }

                  if (!tile.hasTrail && !tile.revealed) {
                    weight += 5;
                  }

                  weight += Math.random() * 0.5;
                  return weight;
                });

                const totalWeight = weights.reduce((a, b) => a + b, 0);
                let rand = Math.random() * totalWeight;
                for (let i = 0; i < unvisitedNeighbors.length; i++) {
                  rand -= weights[i];
                  if (rand <= 0) {
                    targetPos = unvisitedNeighbors[i];
                    break;
                  }
                }
                if (!targetPos) targetPos = unvisitedNeighbors[0];
              } else {
                newAnt.state = "return";
                newAnt.trailIndex = newAnt.trailHistory.length - 1;
                validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                targetPos = validNeighbors[0];
              }
              break;
            }

            case "harvest": {
              const visitedSet = new Set(ant.trailHistory.slice(-5).map(pos => `${pos.x},${pos.y}`));
              const foodNeighbors = validNeighbors.filter(p => {
                const key = `${p.x},${p.y}`;
                return newMap[p.y][p.x].foodPheromone > 0 && !visitedSet.has(key);
              });

              if (foodNeighbors.length > 0) {
                foodNeighbors.sort((a, b) => newMap[b.y][b.x].foodPheromone - newMap[a.y][a.x].foodPheromone);
                targetPos = foodNeighbors[0];
              } else {
                if (distance(ant.pos, prev.nestPos) <= 1) {
                  const nearNest = validNeighbors.filter(p => distance(p, prev.nestPos) <= 2);
                  if (nearNest.length > 0) {
                    targetPos = nearNest[Math.floor(Math.random() * nearNest.length)];
                  } else {
                    targetPos = validNeighbors[0];
                  }
                } else {
                  validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                  targetPos = validNeighbors[0];
                }
              }
              break;
            }

            case "return": {
              if (distance(ant.pos, prev.nestPos) <= 1 && newAnt.carriedInfo === null) {
                newAnt.trailHistory = [{ ...prev.nestPos }];
                newAnt.trailIndex = 0;
                newAnt.state = prev.directive;
                targetPos = null;
              } else {
                if (newAnt.trailIndex > 0) {
                  const backtrackTarget = newAnt.trailHistory[newAnt.trailIndex - 1];
                  const canBacktrack = validNeighbors.some(p => p.x === backtrackTarget.x && p.y === backtrackTarget.y);
                  if (canBacktrack) {
                    targetPos = backtrackTarget;
                    newAnt.trailIndex--;
                  }
                }

                if (!targetPos) {
                  validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                  targetPos = validNeighbors[0];
                }
              }
              break;
            }

            case "defend": {
              const distToNest = distance(ant.pos, prev.nestPos);

              if (distToNest > 2) {
                if (newAnt.trailIndex > 0) {
                  const backtrackTarget = newAnt.trailHistory[newAnt.trailIndex - 1];
                  const canBacktrack = validNeighbors.some(p => p.x === backtrackTarget.x && p.y === backtrackTarget.y);
                  if (canBacktrack) {
                    targetPos = backtrackTarget;
                    newAnt.trailIndex--;
                  }
                }

                if (!targetPos) {
                  validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                  targetPos = validNeighbors[0];
                }
              } else {
                const nearNest = validNeighbors.filter(p => distance(p, prev.nestPos) <= 2);
                if (nearNest.length > 0) {
                  targetPos = nearNest[Math.floor(Math.random() * nearNest.length)];
                } else {
                  targetPos = validNeighbors[0];
                }
                newAnt.trailHistory = [{ ...prev.nestPos }];
                newAnt.trailIndex = 0;
              }
              break;
            }
          }

          if (targetPos) {
            newAnt.pos = targetPos;

            const isGoingOut = newAnt.state === "explore" || newAnt.state === "harvest";
            if (isGoingOut) {
              newAnt.trailHistory.push({ ...targetPos });
              newAnt.trailIndex = newAnt.trailHistory.length - 1;

              if (newAnt.trailHistory.length > 100) {
                newAnt.trailHistory = newAnt.trailHistory.slice(-100);
                newAnt.trailIndex = newAnt.trailHistory.length - 1;
              }
            }

            const newTile = newMap[targetPos.y][targetPos.x];

            if (newTile.type === "spider") {
              newAnt.isAlive = false;
              return newAnt;
            }

            if (newTile.type === "food" && newAnt.carriedInfo === null && isGoingOut) {
              newAnt.carriedInfo = "food";
              newAnt.state = "return";
              newMap[targetPos.y][targetPos.x].foodPheromone = 1;
            }

            if (newAnt.carriedInfo === "food" && newAnt.state === "return") {
              newMap[targetPos.y][targetPos.x].foodPheromone = Math.min(
                1,
                newMap[targetPos.y][targetPos.x].foodPheromone + 0.5,
              );
            }

            newMap[targetPos.y][targetPos.x].homePheromone = Math.max(
              newMap[targetPos.y][targetPos.x].homePheromone,
              newMap[ant.pos.y]?.[ant.pos.x]?.homePheromone * 0.9 || 0,
            );
          }

          return newAnt;
        });

      // Spawn new ants
      const aliveAnts = newAnts.filter(a => a.isAlive);
      if (newFood >= SPAWN_FOOD_COST && aliveAnts.length < MAX_ANTS) {
        newFood -= SPAWN_FOOD_COST;
        newAntsToSpawn.push({
          id: antIdCounter,
          pos: { ...prev.nestPos },
          prevPos: { ...prev.nestPos },
          state: prev.directive === "defend" ? "defend" : "explore",
          carriedInfo: null,
          trailHistory: [{ ...prev.nestPos }],
          trailIndex: 0,
          heading: randomHeading(prev.nestPos),
          isAlive: true,
          ticksSinceSpawn: 0,
          color: ANT_COLORS[antIdCounter % ANT_COLORS.length],
        });
        antIdCounter++;
      }

      const allAnts = [...newAnts, ...newAntsToSpawn];
      const finalAliveAnts = allAnts.filter(a => a.isAlive);

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

      lastTickTime.current = Date.now();

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

  // Canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gameState) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      // Calculate interpolation for smooth movement
      const timeSinceLastTick = Date.now() - lastTickTime.current;
      const tickDuration = TICK_INTERVAL / gameSpeed;
      const interpolation = isPaused ? 1 : Math.min(1, timeSinceLastTick / tickDuration);

      renderGame(ctx, gameState, interpolation);
      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [gameState, isPaused, gameSpeed]);

  // Start game loop
  useEffect(() => {
    initGame();
  }, [initGame]);

  useEffect(() => {
    if (gameState && !gameState.gameOver && !isPaused) {
      tickRef.current = setInterval(gameTick, TICK_INTERVAL / gameSpeed);
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
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
        <p className="text-amber-100/80 text-sm max-w-md">
          Guide your colony through pheromone directives. Watch your ants explore the unknown...
        </p>
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
        {gameState.directive === "explore" && "Ants venture into unknown territory. Higher risk, faster discovery."}
        {gameState.directive === "harvest" && "Ants follow food trails. Safer, but less exploration."}
        {gameState.directive === "defend" && "Ants return to nest and patrol nearby. Safe, but no new food."}
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
            imageRendering: "pixelated",
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
            <span className="w-4 h-4 rounded-full bg-amber-700 border border-amber-600"></span>
            Nest
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-stone-900 border border-stone-600"></span>
            Ant
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-red-500"></span>
            Food
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-stone-900 border border-red-500"></span>
            Spider
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-stone-800"></span>
            Fog
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded" style={{ background: "linear-gradient(90deg, #FF6B6B, #4ECDC4)" }}></span>
            Ant trails
          </span>
          <span className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-green-600/60"></span>
            Food route
          </span>
        </div>
      </div>

      <p className="mt-4 text-amber-200/40 text-xs">
        Tip: Each ant leaves a unique colored trail. Watch them explore and discover food!
      </p>
    </div>
  );
};

export default Home;
