const assert = require('node:assert/strict');
const vscode = require('vscode');
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
  console.log('Squeze extension host: activation, tool registration, context and expansion passed.');
};
