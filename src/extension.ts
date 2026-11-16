import * as vscode from 'vscode';
import { isAbsolute, join, relative } from 'node:path';
import { Engine } from './engine.js';
import { repositoryMap } from './context.js';
import { INSTRUCTIONS } from './instructions.js';
import { findSymbols, renderOutline, renderSymbols } from './symbols.js';
import { loadGraph, runGraph, type GraphView } from './graph-store.js';
import type { CodeGraph } from './graph.js';
import { SourceChangedError } from './repository.js';
import { buildExplorerModel, explorerOpenPath, isShownPath, type ExplorerModel } from './explorer-model.js';
import { readExplorerAssets, renderExplorerHtml, type ExplorerAssets } from './explorer-html.js';
import { createRefreshScheduler, isWatchedPath, type RefreshScheduler } from './live-refresh.js';
import { TokenLedger } from './token-ledger.js';
import { indexedStatus, ledgerMarkdown } from './status-text.js';

const LEDGER_KEY = 'squeze.ledger';
const REFRESH_DELAY_MS = 1200;
const MAX_REFRESH_ATTEMPTS = 3;

type IndexState = 'idle' | 'indexing' | 'ready' | 'failed';

interface Session {
  readonly key: string;
  readonly folder: vscode.WorkspaceFolder;
  readonly engine: Engine;
  state: IndexState;
  error?: string;
  graph?: CodeGraph;
  model?: ExplorerModel;
  indexedAt?: number;
  pending: Promise<void>;
  scheduler?: RefreshScheduler;
  watcher?: vscode.FileSystemWatcher;
}

interface ExplorerView {
  readonly panel: vscode.WebviewPanel;
  session: Session;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ContextInput {query:string;budget?:number}
interface GraphInput {mode?:GraphView;target?:string;to?:string;depth?:number;budget?:number}
interface ExpandInput {path:string;start:number;end:number;budget?:number}
interface MapInput {path?:string;query?:string;budget?:number}
export function activate(context: vscode.ExtensionContext) {
  const config = () => vscode.workspace.getConfiguration('squeze');
  const sessions = new Map<string, Session>();
  const ledger = TokenLedger.fromJSON(context.workspaceState.get(LEDGER_KEY));
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Squeze';
  statusItem.command = 'squeze.explore';
  context.subscriptions.push(statusItem);
  let current: Session | undefined;
  let explorer: ExplorerView | undefined;
  let assets: ExplorerAssets | undefined;

  function getSession(): Session {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before indexing.');
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local repository folder first.');
    const model = config().get<string>('semanticModel', '');
    const features = config().get<string>('features', '');
    const key = folder.uri.fsPath + '\0' + model + '\0' + features;
    let session = sessions.get(key);
    if (!session) {
      session = {
        key,
        folder,
        state: 'idle',
        pending: Promise.resolve(),
        engine: new Engine(folder.uri.fsPath, { semanticModel: model || undefined, features: features || undefined }),
      };
      sessions.set(key, session);
      if (config().get<boolean>('autoRefresh', true)) {
        startWatcher(session);
        void refresh(session, false);
      }
    }
    current = session;
    return session;
  }

  function startWatcher(session: Session): void {
    if (session.watcher) return;
    const root = session.folder.uri.fsPath;
    session.scheduler = createRefreshScheduler(() => refresh(session, false), { delayMs: REFRESH_DELAY_MS });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(session.folder, '**/*'));
    const onChange = (uri: vscode.Uri) => {
      const rel = relative(root, uri.fsPath);
      if (!rel || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..') return;
      if (isWatchedPath(rel)) session.scheduler?.trigger();
    };
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    session.watcher = watcher;
  }

  function stopWatcher(session: Session): void {
    session.watcher?.dispose();
    session.scheduler?.dispose();
    session.watcher = undefined;
    session.scheduler = undefined;
  }

  function disposeSessions(): void {
    for (const session of sessions.values()) stopWatcher(session);
    sessions.clear();
    current = undefined;
    explorer?.panel.dispose();
    explorer = undefined;
  }

  function refresh(session: Session, force: boolean): Promise<void> {
    const run = session.pending.then(() => refreshNow(session, force));
    session.pending = run;
    return run;
  }

  async function refreshNow(session: Session, force: boolean): Promise<void> {
    session.state = 'indexing';
    updateStatus();
    try {
      const changed = await rebuildIfChanged(session, force);
      session.state = 'ready';
      session.error = undefined;
      session.indexedAt = Date.now();
      if (changed) pushModel(session);
    } catch (error) {
      session.state = 'failed';
      session.error = messageOf(error);
    }
    updateStatus();
  }

  async function rebuildIfChanged(session: Session, force: boolean): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (!force && session.graph) {
          const { revision } = await session.engine.snapshot('__repository_map__');
          if (revision === session.graph.revision) return false;
        }
        const { graph } = await loadGraph(session.engine);
        session.graph = graph;
        session.model = undefined;
        return true;
      } catch (error) {
        // A file changed while it was being read; a retry normally succeeds.
        if (error instanceof SourceChangedError && attempt < MAX_REFRESH_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  function modelFor(session: Session): ExplorerModel | undefined {
    if (!session.graph) return undefined;
    if (!session.model) {
      const ignore = vscode.workspace.getConfiguration('squeze', session.folder.uri).get<string[]>('explorer.ignore', []);
      session.model = buildExplorerModel(session.graph, { title: session.folder.name, ignore });
    }
    return session.model;
  }

  function pushModel(session: Session): void {
    const view = explorer;
    const model = modelFor(session);
    if (view?.session === session && model) void view.panel.webview.postMessage({ type: 'model', model });
  }

  function explorerAssets(): ExplorerAssets {
    assets ??= readExplorerAssets(join(context.extensionPath, 'media'));
    return assets;
  }

  function showExplorer(session: Session): void {
    const model = modelFor(session);
    if (!model) throw new Error(session.error ?? 'Squeze could not index this repository.');
    const view = explorer;
    if (view) {
      view.panel.reveal();
      if (view.session === session) {
        void view.panel.webview.postMessage({ type: 'model', model });
      } else {
        view.session = session;
        view.panel.title = `Squeze: ${session.folder.name}`;
        view.panel.webview.html = renderExplorerHtml(model, explorerAssets());
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('squeze.explorer', `Squeze: ${session.folder.name}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const created: ExplorerView = { panel, session };
    explorer = created;
    panel.webview.html = renderExplorerHtml(model, explorerAssets());
    panel.onDidDispose(() => { if (explorer === created) explorer = undefined; });
    panel.webview.onDidReceiveMessage(message => { void openFromExplorer(created, message).catch(error => vscode.window.showErrorMessage(messageOf(error))); });
  }

  async function openFromExplorer(view: ExplorerView, message: unknown): Promise<void> {
    const path = explorerOpenPath(message);
    const model = view.session.model;
    if (!path || !model || !isShownPath(model, path)) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(view.session.folder.uri, path));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async function openExplorer(): Promise<void> {
    const session = getSession();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Squeze: reading repository' }, () => refresh(session, false));
    if (session.state === 'failed' || !session.graph) throw new Error(session.error ?? 'Squeze could not index this repository.');
    showExplorer(session);
  }

  async function refreshIndex(): Promise<void> {
    const session = getSession();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Squeze: refreshing index' }, () => refresh(session, true));
    if (session.state === 'failed' || !session.graph) throw new Error(session.error ?? 'Squeze could not index this repository.');
    vscode.window.showInformationMessage(`Squeze: indexed ${session.graph.fileCount.toLocaleString('en-US')} files.`);
  }

  function recordPack(tool: string, stats: { inputTokens: number; outputTokens: number }): void {
    ledger.record(tool, { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens });
    void context.workspaceState.update(LEDGER_KEY, ledger.toJSON());
    updateStatus();
  }

  function updateStatus(): void {
    const session = current;
    statusItem.backgroundColor = undefined;
    if (!vscode.workspace.isTrusted) {
      statusItem.text = '$(lock) Squeze';
      statusItem.tooltip = 'Squeze waits for workspace trust before indexing.';
    } else if (!session || session.state === 'idle') {
      statusItem.text = '$(graph) Squeze';
      statusItem.tooltip = 'Squeze: open the Code Explorer, or run Squeze: Refresh Index.';
    } else if (session.state === 'indexing') {
      statusItem.text = '$(sync~spin) Squeze indexing…';
      statusItem.tooltip = 'Squeze is indexing this repository.';
    } else if (session.state === 'failed') {
      statusItem.text = '$(warning) Squeze index failed';
      statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusItem.tooltip = session.error ?? 'Squeze could not index this repository.';
    } else if (session.graph) {
      statusItem.text = indexedStatus(session.graph.fileCount, ledger.totals().savedTokens);
      statusItem.tooltip = readyTooltip(session, session.graph);
    }
    statusItem.show();
  }

  function readyTooltip(session: Session, graph: CodeGraph): vscode.MarkdownString {
    const totals = ledger.totals();
    const tip = new vscode.MarkdownString('', true);
    tip.appendMarkdown('**Squeze** · ');
    tip.appendText(session.folder.name);
    tip.appendMarkdown(`\n\nFiles: ${graph.fileCount.toLocaleString('en-US')} · Subsystems: ${graph.subsystems.length.toLocaleString('en-US')}`);
    tip.appendMarkdown(`\n\nLast checked: ${session.indexedAt ? new Date(session.indexedAt).toLocaleTimeString() : 'never'}`);
    tip.appendMarkdown(`\n\nPack calls: ${totals.calls.toLocaleString('en-US')} · est. saved: ${totals.savedTokens.toLocaleString('en-US')} tokens (estimate, not billing)`);
    tip.appendMarkdown('\n\nClick to open the Code Explorer.');
    return tip;
  }

  function command(id: string, run: () => Promise<unknown>): void {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await run(); } catch (error) { vscode.window.showErrorMessage(messageOf(error)); }
    }));
  }
  const defaultBudget = () => vscode.workspace.getConfiguration('squeze').get<number>('tokenBudget',3000);
  const show = async (text: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:text,language:'markdown'}),{preview:true});
  context.subscriptions.push(vscode.commands.registerCommand('squeze.pack',async () => {
    const query = await vscode.window.showInputBox({prompt:'What do you want to understand or change?',placeHolder:'Where is retry backoff calculated?'});
    if (!query) return;
    try {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Squeze: reading repository'},async () => {
        const result = await getSession().engine.context(query,defaultBudget());
        recordPack('squeze.pack',result.stats);
        await show(result.text);
        vscode.window.showInformationMessage(`Squeze: ${result.stats.outputTokens.toLocaleString()} tokens (${result.stats.tokenizer}); ${(result.stats.reduction*100).toFixed(1)}% smaller than full indexed repository. This is not measured billing savings.`);
      });
    } catch(e) { vscode.window.showErrorMessage(String(e)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('squeze.map',async () => {
    try { await show(repositoryMap(await getSession().engine.snapshot('__repository_map__'),defaultBudget())); } catch(e) {vscode.window.showErrorMessage(String(e));}
  }));
  // squeze.graph keeps its id; it now opens the Code Explorer.
  command('squeze.graph', openExplorer);
  command('squeze.explore', openExplorer);
  command('squeze.refresh', refreshIndex);
  command('squeze.stats', async () => { await show(ledgerMarkdown(ledger.totals(), ledger.recent(10))); });
  context.subscriptions.push(vscode.commands.registerCommand('squeze.setup',async () => {
    try {
      const repo = getSession().engine;
      const dir = vscode.Uri.file(`${repo.root}/.github/instructions`);
      const target = vscode.Uri.joinPath(dir,'squeze.instructions.md');
      try { await vscode.workspace.fs.stat(target); await vscode.window.showTextDocument(target); return; } catch {}
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(target,Buffer.from(`---\napplyTo: "**"\n---\n${INSTRUCTIONS}`));
      await vscode.window.showTextDocument(target);
    } catch(e) {vscode.window.showErrorMessage(String(e));}
  }));
  context.subscriptions.push(vscode.lm.registerTool<ContextInput>('squeze_context',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const pack = await getSession().engine.context(options.input.query,options.input.budget ?? defaultBudget());
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      recordPack('squeze_context',pack.stats);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(pack.text)]);
    }
  }));
  context.subscriptions.push(vscode.lm.registerTool<ExpandInput>('squeze_expand',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const {path,start,end,budget} = options.input;
      const text = await getSession().engine.expandRange(path,start,end,budget ?? defaultBudget());
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
  }));
  context.subscriptions.push(vscode.lm.registerTool<MapInput>('squeze_map',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const {path,query,budget} = options.input;
      const repo = getSession().engine;
      const limit = budget ?? 1500;
      let text: string;
      if (path) {
        const file = (await repo.snapshot(path)).files.find(candidate => candidate.path === path);
        if (!file) throw new Error('Path is excluded, absent, outside repository, or beyond scan limits');
        text = renderOutline(file.path,file.chunks,file.text.split('\n').length,limit);
      } else {
        const snapshot = await repo.snapshot(query ?? '__repository_map__');
        text = query ? renderSymbols(findSymbols(snapshot,query),limit) : repositoryMap(snapshot,limit);
      }
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
  }));
  context.subscriptions.push(vscode.lm.registerTool<GraphInput>('squeze_graph',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const {mode,target,to,depth,budget} = options.input;
      const text = await runGraph(getSession().engine,{mode,target,to,depth,budget:budget ?? 1500});
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('squeze.semanticModel') || event.affectsConfiguration('squeze.features')) {
      disposeSessions();
    } else if (event.affectsConfiguration('squeze.autoRefresh')) {
      for (const session of sessions.values()) {
        stopWatcher(session);
        if (config().get<boolean>('autoRefresh', true)) {
          startWatcher(session);
          void refresh(session, false);
        }
      }
    } else if (event.affectsConfiguration('squeze.explorer.ignore')) {
      for (const session of sessions.values()) session.model = undefined;
      if (explorer) pushModel(explorer.session);
    }
    updateStatus();
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    try { getSession(); } catch {}
    updateStatus();
  }));
  context.subscriptions.push({ dispose: disposeSessions });
  updateStatus();
  if (vscode.workspace.isTrusted) {
    try { getSession(); } catch {}
  }
}
export function deactivate() {}
