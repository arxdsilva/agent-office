import { BrowserWindow, dialog } from 'electron'

/** Native file/folder picker (main only). Returns absolute paths; the composition root turns them into refs. */
export function electronDialog(): { pick(kind: 'files' | 'folder'): Promise<string[]> } {
  return {
    async pick(kind) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: kind === 'folder' ? 'Choose a folder' : 'Add files',
        properties:
          kind === 'folder'
            ? ['openDirectory', 'createDirectory']
            : ['openFile', 'multiSelections'],
      }
      const r = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return r.canceled ? [] : r.filePaths
    },
  }
}
