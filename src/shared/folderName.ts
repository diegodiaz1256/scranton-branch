/**
 * The last folder of a path, for labels like an agent's project name.
 *
 * Splits on BOTH separators: a Windows `C:\work\repo` or a WSL
 * `\\wsl.localhost\Ubuntu\home\me\repo` contains no '/' at all, so a
 * '/'-only split returned the whole absolute path as the "name". Empty
 * segments are dropped, so a trailing separator still yields the folder.
 */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
