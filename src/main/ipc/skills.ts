// IPC handlers for Skill Gateway v2.
// M2: SkillSource CRUD. Browse / install / sync / uninstall come in later milestones.

import { type AddSkillSourceRequest, IPC_CHANNELS, type SkillSource } from '@shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import { getSkillSourceManager } from '../services/skills/SkillSourceManager';

function broadcastSources(sources: SkillSource[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.SKILLS_SOURCES_CHANGED, sources);
  }
}

export function registerSkillsHandlers(): void {
  const sourceManager = getSkillSourceManager();
  sourceManager.subscribe((sources) => broadcastSources(sources));

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
}

/**
 * Placeholder for app-shutdown cleanup. M5 will replace this with the full
 * gateway manager disposal (scheduler stop, watcher unsubscribe, etc).
 */
export async function stopSkillsManager(): Promise<void> {
  // intentionally empty — no watchers in M2
}
