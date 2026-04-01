/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TeamConfig — read/write team configuration.
 *
 * Teams are stored in `.proto/teams/{name}/config.json`.
 * Each team has a list of members with their agent type and status.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TEAM_CONFIG');

export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
}

export interface TeamConfigData {
  name: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'stopped' | 'completed';
  members: TeamMember[];
}

const TEAMS_DIR = '.proto/teams';

/**
 * Get the path to a team's config file.
 */
export function getTeamConfigPath(
  projectDir: string,
  teamName: string,
): string {
  return path.join(projectDir, TEAMS_DIR, teamName, 'config.json');
}

/**
 * Read a team config. Returns null if not found.
 */
export async function readTeamConfig(
  projectDir: string,
  teamName: string,
): Promise<TeamConfigData | null> {
  const configPath = getTeamConfigPath(projectDir, teamName);
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as TeamConfigData;
  } catch {
    return null;
  }
}

/**
 * Write a team config, creating directories as needed.
 */
export async function writeTeamConfig(
  projectDir: string,
  teamName: string,
  config: TeamConfigData,
): Promise<void> {
  const configPath = getTeamConfigPath(projectDir, teamName);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  config.updatedAt = Date.now();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  debugLogger.debug(`Team config written: ${configPath}`);
}

/**
 * List all team names in the project.
 */
export async function listTeams(projectDir: string): Promise<string[]> {
  const teamsDir = path.join(projectDir, TEAMS_DIR);
  try {
    const entries = await fs.readdir(teamsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Create a new team config.
 */
export async function createTeam(
  projectDir: string,
  teamName: string,
  members: Array<{ name: string; agentType: string }>,
): Promise<TeamConfigData> {
  const config: TeamConfigData = {
    name: teamName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active',
    members: members.map((m) => ({
      name: m.name,
      agentId: `${m.name}-${Date.now()}`,
      agentType: m.agentType,
      status: 'idle' as const,
    })),
  };
  await writeTeamConfig(projectDir, teamName, config);
  return config;
}

/**
 * Update a member's status in a team config.
 */
export async function updateMemberStatus(
  projectDir: string,
  teamName: string,
  memberName: string,
  status: TeamMember['status'],
): Promise<TeamConfigData | null> {
  const config = await readTeamConfig(projectDir, teamName);
  if (!config) return null;

  const member = config.members.find((m) => m.name === memberName);
  if (!member) return null;

  member.status = status;
  if (status === 'running') member.startedAt = Date.now();
  if (status === 'completed' || status === 'failed')
    member.completedAt = Date.now();

  await writeTeamConfig(projectDir, teamName, config);
  return config;
}

/**
 * Stop a team — mark as stopped and set all running members to idle.
 */
export async function stopTeam(
  projectDir: string,
  teamName: string,
): Promise<TeamConfigData | null> {
  const config = await readTeamConfig(projectDir, teamName);
  if (!config) return null;

  config.status = 'stopped';
  for (const member of config.members) {
    if (member.status === 'running') {
      member.status = 'idle';
    }
  }

  await writeTeamConfig(projectDir, teamName, config);
  return config;
}

/**
 * Delete a team config directory.
 */
export async function deleteTeam(
  projectDir: string,
  teamName: string,
): Promise<boolean> {
  const teamDir = path.join(projectDir, TEAMS_DIR, teamName);
  try {
    await fs.rm(teamDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
