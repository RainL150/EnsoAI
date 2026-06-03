// IPC handlers for Skill Gateway v2.
// Combines source CRUD (M2) and skill orchestration (M5+).

import {
  type AddSkillSourceRequest,
  type InstalledSkill,
  type InstallSkillRequest,
  IPC_CHANNELS,
  type SkillInstallMode,
  type SkillSource,
  type SkillTarget,
  type UninstallSkillOptions,
  type UpdateAvailableInfo,
} from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import { getSkillGatewayManager } from '../services/skills/SkillGatewayManager';
import { getSkillSourceManager } from '../services/skills/SkillSourceManager';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

export function registerSkillsHandlers(): void {
  const sourceManager = getSkillSourceManager();
  const gateway = getSkillGatewayManager();

  sourceManager.subscribe((sources) => broadcast(IPC_CHANNELS.SKILLS_SOURCES_CHANGED, sources));
  gateway.subscribe((skills) => broadcast(IPC_CHANNELS.SKILLS_CHANGED, skills));
  gateway.subscribeUpdates((updates) => broadcast(IPC_CHANNELS.SKILLS_UPDATES_AVAILABLE, updates));

  // ----- Sources -----

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SOURCES_LIST,
    async (): Promise<SkillSource[]> => sourceManager.list()
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SOURCES_ADD,
    async (_event, req: AddSkillSourceRequest): Promise<SkillSource> => sourceManager.add(req)
  );

  ipcMain.handle(IPC_CHANNELS.SKILLS_SOURCES_REMOVE, async (_event, id: string): Promise<void> => {
    await sourceManager.remove(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SOURCES_SET_ENABLED,
    async (_event, id: string, enabled: boolean): Promise<void> => {
      await sourceManager.setEnabled(id, enabled);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SOURCES_UPDATE,
    async (
      _event,
      id: string,
      patch: Partial<Pick<SkillSource, 'name' | 'branch' | 'sourceDir' | 'localPath'>>
    ): Promise<SkillSource> => sourceManager.update(id, patch)
  );

  // ----- Skills (installed) -----

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_LIST,
    async (): Promise<InstalledSkill[]> => gateway.listInstalled()
  );

  ipcMain.handle(IPC_CHANNELS.SKILLS_BROWSE, async (_event, sourceId?: string) =>
    gateway.browse(sourceId)
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_INSTALL,
    async (_event, req: InstallSkillRequest): Promise<InstalledSkill> => gateway.install(req)
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_UNINSTALL,
    async (_event, id: string, options?: UninstallSkillOptions): Promise<void> => {
      await gateway.uninstall(id, options ?? {});
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SYNC,
    async (_event, id: string): Promise<InstalledSkill> => gateway.sync(id)
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SET_ENABLED,
    async (_event, id: string, enabled: boolean): Promise<void> => {
      await gateway.setEnabled(id, enabled);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_SET_TARGETS,
    async (
      _event,
      id: string,
      targets: Partial<Record<SkillTarget, { mode: SkillInstallMode }>>
    ): Promise<void> => {
      await gateway.setTargets(id, targets);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SKILLS_OPEN_FOLDER, async (_event, id: string): Promise<void> => {
    await gateway.openFolder(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_CHECK_STATUS,
    async (): Promise<InstalledSkill[]> => gateway.checkAllStatuses()
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_CHECK_UPDATES,
    async (): Promise<UpdateAvailableInfo[]> => gateway.checkForUpdates()
  );
}

export async function stopSkillsManager(): Promise<void> {
  await getSkillGatewayManager().dispose();
}
