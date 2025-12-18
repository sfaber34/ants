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
  state: AntState;
  carriedInfo: "food" | "danger" | null;
  trailHistory: Position[]; // Where the ant has been
  trailIndex: number; // Current position in trail when backtracking
  heading: Position; // General direction the ant is heading (for exploration)
  isAlive: boolean;
  ticksSinceSpawn: number;
}

interface Tile {
  type: TileType;
  homePheromone: number; // Strength 0-1
  foodPheromone: number; // Strength 0-1
  revealed: boolean; // Has the player learned about this tile?
  hasTrail: boolean; // Is there a visible trail here?
  trailStrength: number; // How strong is the trail?
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
const PHEROMONE_DECAY = 0.005; // Much slower decay
const TRAIL_DECAY = 0.003; // Much slower trail fade
const MAX_ANTS = 15;
const INITIAL_ANTS = 2;
const INITIAL_FOOD = 5; // Lower starting food so we don't auto-spawn ants
const WIN_FOOD = 30;
const STARVATION_TICKS = 300;
const MIN_ANTS_TO_SURVIVE = 1;
const SPAWN_FOOD_COST = 5; // Higher cost to spawn new ants
const TICK_INTERVAL = 1200; // ms - slower so you can watch

// Map layout - true map (player doesn't see this initially)
// 🟫 = border, . = ground, F = food, S = spider, N = nest
// Nest is in the CENTER so ants can explore in all directions
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
        charIndex += 2; // emoji is 2 chars
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

    // Fill remaining if needed
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

  // Reveal area around nest
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

// Generate a random heading direction (away from nest, toward edges)
const randomHeading = (nestPos: Position): Position => {
  // Pick a random angle and create a unit direction
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
      state: "explore",
      carriedInfo: null,
      trailHistory: [{ ...nestPos }],
      trailIndex: 0,
      heading: randomHeading(nestPos),
      isAlive: true,
      ticksSinceSpawn: 0,
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

// ============================================
// GAME COMPONENT
// ============================================

const Home: NextPage = () => {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [gameSpeed, setGameSpeed] = useState(1);
  const tickRef = useRef<NodeJS.Timeout | null>(null);

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
  }, []);

  // Game tick logic
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
          const newAnt = { ...ant, ticksSinceSpawn: ant.ticksSinceSpawn + 1 };
          const currentTile = newMap[ant.pos.y][ant.pos.x];

          // Deposit trail
          newMap[ant.pos.y][ant.pos.x] = {
            ...currentTile,
            hasTrail: true,
            trailStrength: Math.min(1, currentTile.trailStrength + 0.3),
          };

          // If carrying food, deposit pheromone on CURRENT tile (before any state changes)
          if (ant.carriedInfo === "food") {
            newMap[ant.pos.y][ant.pos.x].foodPheromone = Math.min(1, newMap[ant.pos.y][ant.pos.x].foodPheromone + 0.5);
          }

          // Check if at nest and carrying info - DELIVER FOOD
          if (distance(ant.pos, prev.nestPos) <= 1 && ant.carriedInfo === "food") {
            newFood += 1;
            ticksSinceLastFood = 0;
            newAnt.carriedInfo = null;

            // Reveal the ant's trail (the path it took)
            ant.trailHistory.forEach(pos => {
              newMap[pos.y][pos.x].revealed = true;
            });

            // Also deposit food pheromone on the NEST itself so harvest ants can find the start
            newMap[prev.nestPos.y][prev.nestPos.x].foodPheromone = Math.min(
              1,
              newMap[prev.nestPos.y][prev.nestPos.x].foodPheromone + 0.3,
            );

            // RESET trail for new journey outward
            newAnt.trailHistory = [{ ...prev.nestPos }];
            newAnt.trailIndex = 0;

            // What to do next?
            if (prev.directive === "defend") {
              newAnt.state = "defend";
            } else if (prev.directive === "harvest") {
              newAnt.state = "harvest"; // Go back out for more food!
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
              // EXPLORE = move AWAY from nest, avoid own trail
              const visitedSet = new Set(ant.trailHistory.map(pos => `${pos.x},${pos.y}`));

              // Find unvisited neighbors
              const unvisitedNeighbors = validNeighbors.filter(p => !visitedSet.has(`${p.x},${p.y}`));

              if (unvisitedNeighbors.length > 0) {
                // We have fresh tiles to explore!
                const weights = unvisitedNeighbors.map(p => {
                  const tile = newMap[p.y][p.x];
                  let weight = 1;

                  // STRONGLY prefer moving AWAY from nest
                  const currentDistFromNest = distance(ant.pos, prev.nestPos);
                  const newDistFromNest = distance(p, prev.nestPos);
                  if (newDistFromNest > currentDistFromNest) {
                    weight += 10;
                  } else if (newDistFromNest < currentDistFromNest) {
                    weight *= 0.3;
                  }

                  // Prefer completely unexplored tiles
                  if (!tile.hasTrail && !tile.revealed) {
                    weight += 5;
                  }

                  // Small randomness
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
                // STUCK! All neighbors are in our trail.
                // Head back toward nest to reset - we've explored this area
                newAnt.state = "return";
                newAnt.trailIndex = newAnt.trailHistory.length - 1;
                // Pick tile closest to nest
                validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                targetPos = validNeighbors[0];
              }
              break;
            }

            case "harvest": {
              // HARVEST = follow food pheromone trail TO the food source
              // Track where we've been to avoid bouncing
              const visitedSet = new Set(ant.trailHistory.slice(-5).map(pos => `${pos.x},${pos.y}`));

              // Find neighbors with food pheromone, excluding recently visited
              const foodNeighbors = validNeighbors.filter(p => {
                const key = `${p.x},${p.y}`;
                return newMap[p.y][p.x].foodPheromone > 0 && !visitedSet.has(key);
              });

              if (foodNeighbors.length > 0) {
                // Follow strongest food pheromone
                foodNeighbors.sort((a, b) => newMap[b.y][b.x].foodPheromone - newMap[a.y][a.x].foodPheromone);
                targetPos = foodNeighbors[0];
              } else {
                // No unvisited food trail nearby
                // Check if we're at the nest - if so, wait or explore slightly
                if (distance(ant.pos, prev.nestPos) <= 1) {
                  // At nest but no food trail yet - stay close, patrol near nest
                  const nearNest = validNeighbors.filter(p => distance(p, prev.nestPos) <= 2);
                  if (nearNest.length > 0) {
                    targetPos = nearNest[Math.floor(Math.random() * nearNest.length)];
                  } else {
                    targetPos = validNeighbors[0];
                  }
                } else {
                  // Not at nest and no food trail - HEAD BACK TO NEST to find the trail
                  validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                  targetPos = validNeighbors[0];
                }
              }
              break;
            }

            case "return": {
              // RETURN = head back to nest, following our trail
              // (Food pheromone is deposited at the start of tick processing)

              // Check if we've reached nest (for ants NOT carrying food, e.g. stuck explorers)
              if (distance(ant.pos, prev.nestPos) <= 1 && newAnt.carriedInfo === null) {
                // Reset and go back to exploring or whatever directive says
                newAnt.trailHistory = [{ ...prev.nestPos }];
                newAnt.trailIndex = 0;
                newAnt.state = prev.directive;
                // Stay at nest this tick
                targetPos = null;
              } else {
                // Backtrack along our trail
                if (newAnt.trailIndex > 0) {
                  const backtrackTarget = newAnt.trailHistory[newAnt.trailIndex - 1];
                  const canBacktrack = validNeighbors.some(p => p.x === backtrackTarget.x && p.y === backtrackTarget.y);
                  if (canBacktrack) {
                    targetPos = backtrackTarget;
                    newAnt.trailIndex--;
                  }
                }

                // Fallback: direct navigation toward nest
                if (!targetPos) {
                  validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                  targetPos = validNeighbors[0];
                }
              }

              // Note: Food delivery is handled above
              break;
            }

            case "defend": {
              // DEFEND = head straight back to nest, then patrol nearby
              const distToNest = distance(ant.pos, prev.nestPos);

              if (distToNest > 2) {
                // Not at nest yet - head home!
                // First try: follow our trail if we have one
                if (newAnt.trailIndex > 0) {
                  const backtrackTarget = newAnt.trailHistory[newAnt.trailIndex - 1];
                  const canBacktrack = validNeighbors.some(p => p.x === backtrackTarget.x && p.y === backtrackTarget.y);
                  if (canBacktrack) {
                    targetPos = backtrackTarget;
                    newAnt.trailIndex--;
                  }
                }

                // Fallback: just pick the tile CLOSEST to nest (direct navigation)
                if (!targetPos) {
                  validNeighbors.sort((a, b) => distance(a, prev.nestPos) - distance(b, prev.nestPos));
                  targetPos = validNeighbors[0];
                }
              } else {
                // At nest - patrol nearby (stay within 2 tiles)
                const nearNest = validNeighbors.filter(p => distance(p, prev.nestPos) <= 2);
                if (nearNest.length > 0) {
                  targetPos = nearNest[Math.floor(Math.random() * nearNest.length)];
                } else {
                  targetPos = validNeighbors[0];
                }
                // Reset trail since we're home
                newAnt.trailHistory = [{ ...prev.nestPos }];
                newAnt.trailIndex = 0;
              }
              break;
            }
          }

          if (targetPos) {
            newAnt.pos = targetPos;

            // ONLY add to trail when going OUT (explore or harvest)
            // NOT when returning - we need stable indices for backtracking
            const isGoingOut = newAnt.state === "explore" || newAnt.state === "harvest";
            if (isGoingOut) {
              newAnt.trailHistory.push({ ...targetPos });
              newAnt.trailIndex = newAnt.trailHistory.length - 1; // Keep index at end

              // Limit trail history
              if (newAnt.trailHistory.length > 100) {
                newAnt.trailHistory = newAnt.trailHistory.slice(-100);
                newAnt.trailIndex = newAnt.trailHistory.length - 1;
              }
            }

            const newTile = newMap[targetPos.y][targetPos.x];

            // Check for spider - instant death, no notification
            if (newTile.type === "spider") {
              newAnt.isAlive = false;
              return newAnt;
            }

            // Check for food - only pick up if in explore or harvest mode
            if (newTile.type === "food" && newAnt.carriedInfo === null && isGoingOut) {
              newAnt.carriedInfo = "food";
              newAnt.state = "return";
              // trailIndex already points to current position (food location)
              // Mark strong food pheromone at food source
              newMap[targetPos.y][targetPos.x].foodPheromone = 1;
            }

            // If carrying food and returning, deposit food pheromone on EVERY tile we move through
            if (newAnt.carriedInfo === "food" && newAnt.state === "return") {
              newMap[targetPos.y][targetPos.x].foodPheromone = Math.min(
                1,
                newMap[targetPos.y][targetPos.x].foodPheromone + 0.5,
              );
            }

            // Deposit home pheromone on explored tiles (helps others find way back)
            newMap[targetPos.y][targetPos.x].homePheromone = Math.max(
              newMap[targetPos.y][targetPos.x].homePheromone,
              newMap[ant.pos.y]?.[ant.pos.x]?.homePheromone * 0.9 || 0,
            );
          }

          return newAnt;
        });

      // Spawn new ants if we have enough food
      const aliveAnts = newAnts.filter(a => a.isAlive);
      if (newFood >= SPAWN_FOOD_COST && aliveAnts.length < MAX_ANTS) {
        newFood -= SPAWN_FOOD_COST;
        newAntsToSpawn.push({
          id: antIdCounter,
          pos: { ...prev.nestPos },
          state: prev.directive === "defend" ? "defend" : "explore",
          carriedInfo: null,
          trailHistory: [{ ...prev.nestPos }],
          trailIndex: 0,
          heading: randomHeading(prev.nestPos),
          isAlive: true,
          ticksSinceSpawn: 0,
        });
        antIdCounter++;
      }

      const allAnts = [...newAnts, ...newAntsToSpawn];
      const finalAliveAnts = allAnts.filter(a => a.isAlive);

      // Check win/lose conditions
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Render tile as a colored element
  // Returns { content, bgColor, textColor }
  const getTileDisplay = (
    tile: Tile,
    x: number,
    y: number,
    ants: Ant[],
    nestPos: Position,
  ): { content: string; bgColor: string; textColor?: string } => {
    const antsHere = ants.filter(a => a.isAlive && a.pos.x === x && a.pos.y === y);
    const isNest = x === nestPos.x && y === nestPos.y;

    // Nest
    if (isNest) return { content: "🏠", bgColor: "#5d4037" };

    // Ants are ALWAYS visible
    if (antsHere.length > 0) {
      // Show ant on appropriate background
      const bgColor = tile.revealed
        ? tile.foodPheromone > 0.1
          ? "#2e7d32" // Green if on food trail
          : "#8d6e63" // Light brown if explored
        : tile.hasTrail
          ? "#78909c" // Gray-blue if on trail in fog
          : "#4e342e"; // Dark brown if in fog
      return { content: "🐜", bgColor };
    }

    // Border
    if (tile.type === "border") return { content: "", bgColor: "#3e2723" };

    // REVEALED tiles (ant made it back with info)
    if (tile.revealed) {
      if (tile.type === "food") return { content: "🍎", bgColor: "#33691e" };
      if (tile.type === "spider") return { content: "☠️", bgColor: "#b71c1c" };
      // Food pheromone trail (green - known food route)
      if (tile.foodPheromone > 0.1) {
        const intensity = Math.min(1, tile.foodPheromone);
        return {
          content: "",
          bgColor: `rgba(46, 125, 50, ${0.3 + intensity * 0.5})`,
        };
      }
      // Regular explored ground
      return { content: "", bgColor: "#a1887f" };
    }

    // UNREVEALED with trail (white outgoing trail)
    if (tile.hasTrail && tile.trailStrength > 0.05) {
      const intensity = Math.min(1, tile.trailStrength);
      return {
        content: "",
        bgColor: `rgba(255, 255, 255, ${0.2 + intensity * 0.4})`,
      };
    }

    // Complete fog - flat brown
    return { content: "", bgColor: "#4e342e" };
  };

  if (!gameState) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  const aliveAnts = gameState.ants.filter(a => a.isAlive);

  return (
    <div className="flex flex-col items-center min-h-screen bg-gradient-to-b from-amber-900 via-amber-800 to-stone-900 text-white p-4">
      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-4xl font-bold mb-2 text-amber-200" style={{ fontFamily: "serif" }}>
          🐜 Ant Colony 🐜
        </h1>
        <p className="text-amber-100/80 text-sm max-w-md">
          Guide your colony through pheromone directives. You won&apos;t know what&apos;s out there until your ants
          report back...
        </p>
      </div>

      {/* Stats Bar */}
      <div className="flex gap-6 mb-4 bg-stone-800/50 rounded-lg px-6 py-3">
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
          <div className="bg-stone-800 rounded-xl p-8 text-center">
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

      {/* Game Board */}
      <div
        className="rounded-lg p-1 shadow-2xl border border-amber-900/50"
        style={{
          backgroundColor: "#3e2723",
          display: "grid",
          gridTemplateColumns: `repeat(${MAP_SIZE}, 1fr)`,
          gap: "1px",
        }}
      >
        {gameState.map.map((row, y) =>
          row.map((tile, x) => {
            const display = getTileDisplay(tile, x, y, gameState.ants, gameState.nestPos);
            return (
              <div
                key={`${x}-${y}`}
                className="flex items-center justify-center"
                style={{
                  width: "clamp(14px, 2vw, 22px)",
                  height: "clamp(14px, 2vw, 22px)",
                  backgroundColor: display.bgColor,
                  fontSize: "clamp(10px, 1.5vw, 14px)",
                  transition: "background-color 0.3s ease",
                }}
                title={
                  tile.revealed
                    ? `(${x},${y}) ${tile.type} | Trail: ${tile.trailStrength.toFixed(2)} | Food: ${tile.foodPheromone.toFixed(2)}`
                    : tile.hasTrail
                      ? `Trail strength: ${tile.trailStrength.toFixed(2)}`
                      : "Unknown"
                }
              >
                {display.content}
              </div>
            );
          }),
        )}
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
      <div className="mt-6 text-xs text-amber-200/60 max-w-md flex flex-wrap justify-center gap-3">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "#5d4037" }}>
            🏠
          </span>{" "}
          Nest
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "#4e342e" }}>
            🐜
          </span>{" "}
          Ant
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "#33691e" }}>
            🍎
          </span>{" "}
          Food
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "#b71c1c" }}>
            ☠️
          </span>{" "}
          Danger
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "#4e342e" }}></span> Fog
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "rgba(255,255,255,0.5)" }}></span>{" "}
          Outgoing trail
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "rgba(46,125,50,0.6)" }}></span> Food
          route
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: "#a1887f" }}></span> Explored
        </span>
      </div>

      <p className="mt-4 text-amber-200/40 text-xs">
        Tip: If ants go out and don&apos;t come back, something got them. The silence is your only warning.
      </p>
    </div>
  );
};

export default Home;
