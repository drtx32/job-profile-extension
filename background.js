// 表单资料助手 — service worker

const UNSUPPORTED_PREFIXES = [
  'chrome://',
  'edge://',
  'about:',
  'chrome-extension://'
];

function isSupportedPage(url = '') {
  return Boolean(url) && !UNSUPPORTED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

async function showPanel(tabId) {
  await chrome.tabs.sendMessage(tabId, { action: 'showSidebar' });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isSupportedPage(tab.url)) return;

  try {
    await showPanel(tab.id);
    return;
  } catch (_) {
    // Tabs opened before the extension was reloaded do not have the scripts.
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['styles.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['xlsx.full.min.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['agent-bridge.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await showPanel(tab.id);
  } catch (error) {
    console.error('表单资料助手无法在当前页面启动:', error?.message || error);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'repeat-selected-value') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedPage(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'repeatSelectedValue' });
  } catch (_) {}
});
