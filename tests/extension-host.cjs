const assert = require('node:assert/strict');
const vscode = require('vscode');
async function waitForTabLabel(matches,timeoutMs){
  const deadline=Date.now()+timeoutMs;
  let labels=[];
  while(true){
    labels=vscode.window.tabGroups.all.flatMap(group=>group.tabs.map(tab=>tab.label));
    if(labels.some(matches)||Date.now()>=deadline)return labels;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
exports.run = async function () {
  const extension=vscode.extensions.getExtension('2002-rokkam.squeze-cli');
  assert(extension,'extension is installed in host');
  await extension.activate();assert(extension.isActive);
  const names=vscode.lm.tools.map(t=>t.name);
  assert(names.includes('squeze_context'));assert(names.includes('squeze_expand'));
  const result=await vscode.lm.invokeTool('squeze_context',{input:{query:'contextPack budget',budget:1000},toolInvocationToken:undefined});
  const text=result.content.filter(c=>c instanceof vscode.LanguageModelTextPart).map(c=>c.value).join('\n');
  assert(/squeze/i.test(text));assert(names.includes('squeze_map'));assert(names.includes('squeze_graph'));assert(text.includes('src/context.ts'));
  const expanded=await vscode.lm.invokeTool('squeze_expand',{input:{path:'src/tokens.ts',start:1,end:3,budget:1000},toolInvocationToken:undefined});
  assert(expanded.content.some(c=>c.value?.includes('Tiktoken')));
  const commands=await vscode.commands.getCommands(true);
  for(const id of ['squeze.pack','squeze.map','squeze.graph','squeze.setup','squeze.explore','squeze.refresh','squeze.stats'])assert(commands.includes(id),`command ${id} is registered`);
  await vscode.commands.executeCommand('squeze.refresh');
  await vscode.commands.executeCommand('squeze.explore');
  const labels=await waitForTabLabel(label=>label.startsWith('Squeze:'),8000);
  assert(labels.some(label=>label.startsWith('Squeze:')),`Code Explorer panel opens (tabs: ${JSON.stringify(labels)})`);
  await vscode.commands.executeCommand('squeze.stats');
  const stats=vscode.window.activeTextEditor?.document.getText()??'';
  assert(stats.includes('squeze_context'),'ledger records the context pack call');
  console.log('Squeze extension host: activation, tool registration, context and expansion, commands, Explorer and ledger passed.');
};
