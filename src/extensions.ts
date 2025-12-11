// src/extensions.ts
import * as vscode from 'vscode';

/**
 * VSCode Calendar extension host.
 * - Loads media/calendar.html and injects URIs & CSP source
 * - Persists tasks in globalState
 * - Schedules/ Cancels reminders (in-memory timers) while extension host runs
 * - Handles copy-to-clipboard requests from webview
 */

const REMINDER_KEY = 'vscalendar.reminders'; // optional persistence of last scheduled reminders if desired

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('vscalendar.openCalendar', () => CalendarPanel.createOrShow(context)),
    vscode.commands.registerCommand('vscalendar.addQuickTask', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Task title' });
      if (!title) return;
      const date = await vscode.window.showInputBox({ prompt: 'Date (YYYY-MM-DD)', value: new Date().toISOString().slice(0,10) });
      if (!date) return;
      const tasks = context.globalState.get<any[]>('vscalendar.tasks', []);
      const newTask = { id: Date.now().toString(), title, date, notes: '' };
      tasks.push(newTask);
      await context.globalState.update('vscalendar.tasks', tasks);
      vscode.window.showInformationMessage(`Added task for ${date}: ${title}`);
    })
  );

  // Optionally reschedule persisted reminders here if you persist them across restarts.
}

export function deactivate() {
  // clear timers on deactivate
  reminderTimers.forEach(timeout => clearTimeout(timeout));
  reminderTimers.clear();
}

/* Reminder timer management - in-memory only */
const reminderTimers: Map<string, NodeJS.Timeout> = new Map();

/** schedule a reminder for task at ms timestamp (Date.now() ms) */
function scheduleReminder(task: any, reminderAtMs: number) {
  try {
    // Cancel existing if present
    cancelReminder(task.id);

    const now = Date.now();
    const delay = reminderAtMs - now;
    if (delay <= 0) {
      // time passed — fire immediately
      showReminderNotification(task);
      return;
    }

    const to = setTimeout(() => {
      showReminderNotification(task);
      reminderTimers.delete(task.id);
    }, delay);

    reminderTimers.set(task.id, to);
    // optional: persist info about upcoming reminders if you want across reloads
  } catch (e) {
    console.error('scheduleReminder error', e);
  }
}

function cancelReminder(taskId: string) {
  const t = reminderTimers.get(taskId);
  if (t) {
    clearTimeout(t);
    reminderTimers.delete(taskId);
  }
}

/** show notification for reminder */
function showReminderNotification(task: any) {
  try {
    const label = task.time ? `${task.title} at ${task.time}` : task.title;
    vscode.window.showInformationMessage(`Reminder: ${label}`);
    if (CalendarPanel.currentPanel) {
      CalendarPanel.currentPanel._panel.webview.postMessage({ command: 'reminderFired', taskId: task.id });
    }
  } catch (e) {
    console.error('showReminderNotification error', e);
  }
}

/* Webview Panel class (loads HTML and handles messages) */
class CalendarPanel {
  public static currentPanel: CalendarPanel | undefined;
  public readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (CalendarPanel.currentPanel) {
      CalendarPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel('vscalendar', 'VSCode Calendar', column, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    CalendarPanel.currentPanel = new CalendarPanel(panel, context);
  }

  constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;

    this.loadHtmlTemplate().then(html => {
      const scriptUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'calendar.js'));
      const styleUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'calendar.css'));
      const nonce = getNonce();
      const cspSource = this._panel.webview.cspSource;

      html = html
        .replace(/{{SCRIPT_URI}}/g, scriptUri.toString())
        .replace(/{{STYLE_URI}}/g, styleUri.toString())
        .replace(/{{NONCE}}/g, nonce)
        .replace(/{{CSP_SOURCE}}/g, cspSource);

      this._panel.webview.html = html;
    }).catch(err => {
      vscode.window.showErrorMessage(`Failed to load calendar HTML: ${String(err)}`);
      this._panel.webview.html = `<html><body><h3>Calendar HTML missing</h3><pre>${escapeHtml(String(err))}</pre></body></html>`;
    });

    // receive messages from webview
    this._panel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.command) {
          case 'requestTasks': {
            const tasks = this._context.globalState.get<any[]>('vscalendar.tasks', []);
            this._panel.webview.postMessage({ command: 'loadTasks', tasks });
            break;
          }
          case 'saveTasks': {
            const tasks = message.tasks || [];
            await this._context.globalState.update('vscalendar.tasks', tasks);
            // schedule reminders for tasks included in message
            (tasks || []).forEach((t: any) => {
              if (t.reminderMinutes && t.time) {
                const reminderAt = computeReminderTimestampMs(t.date, t.time, Number(t.reminderMinutes));
                if (reminderAt) scheduleReminder(t, reminderAt);
              } else {
                cancelReminder(t.id);
              }
            });
            vscode.window.showInformationMessage('Calendar tasks saved');
            break;
          }
          case 'scheduleReminder': {
            const { task, reminderAt } = message;
            if (task && reminderAt) scheduleReminder(task, reminderAt);
            break;
          }
          case 'cancelReminder': {
            const { taskId } = message;
            if (taskId) cancelReminder(taskId);
            break;
          }
          case 'copyToClipboard': {
            const { text } = message;
            if (text) {
              await vscode.env.clipboard.writeText(String(text));
              vscode.window.showInformationMessage('Copied task details to clipboard');
            }
            break;
          }
          default:
            console.warn('Unknown message from webview', message);
        }
      } catch (err) {
        console.error('Error handling message from webview', err);
      }
    }, undefined, this._context.subscriptions);

    this._panel.onDidDispose(() => {
      CalendarPanel.currentPanel = undefined;
    }, null, this._context.subscriptions);
  }

  private async loadHtmlTemplate(): Promise<string> {
    const htmlUri = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'calendar.html');
    const bytes = await vscode.workspace.fs.readFile(htmlUri);
    return new TextDecoder().decode(bytes);
  }
}

/** compute ms since epoch for reminder */
function computeReminderTimestampMs(dateStr: string, timeStr: string, minutesBefore: number): number | null {
  try {
    const [y, m, d] = (dateStr || '').split('-').map(Number);
    const [hh, mm] = (timeStr || '').split(':').map(Number);
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, hh || 0, mm || 0, 0);
    return dt.getTime() - (minutesBefore * 60 * 1000);
  } catch {
    return null;
  }
}

/** small helpers */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let n = '';
  for (let i = 0; i < 32; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
  return n;
}
function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
