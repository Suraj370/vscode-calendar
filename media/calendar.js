// media/calendar.js
(function () {
  const vscode = acquireVsCodeApi();
  let tasks = []; // { id, title, date, time, notes, priority, color, reminderMinutes }
  let shownYear, shownMonth;
  let editingTaskId = null;

  // inspector state
  let inspectorTaskId = null;
  const inspector = document.createElement('div');

  function start() {
    const d = new Date();
    shownYear = d.getFullYear();
    shownMonth = d.getMonth();

    // controls
    document.getElementById('prev').addEventListener('click', () => changeMonth(-1));
    document.getElementById('next').addEventListener('click', () => changeMonth(1));
    document.getElementById('newTask').addEventListener('click', () => openModal());
    document.getElementById('save').addEventListener('click', saveToExtension);
    document.getElementById('cancel').addEventListener('click', closeModal);
    document.getElementById('saveTaskBtn').addEventListener('click', saveTaskFromModal);
    document.getElementById('deleteTaskBtn').addEventListener('click', deleteTaskFromModal);

    // inspector actions
    document.getElementById('inspectEdit').addEventListener('click', () => {
      hideInspector();
      if (inspectorTaskId) openModalForEdit(inspectorTaskId);
    });
    document.getElementById('inspectCopy').addEventListener('click', async () => {
      hideInspector();
      if (!inspectorTaskId) return;
      const t = tasks.find(x => x.id === inspectorTaskId);
      if (!t) return;
      const details = `${t.title}${t.time ? ' @' + t.time : ''} on ${t.date}\n${t.notes || ''}`;
      // send to extension host to copy (safer)
      vscode.postMessage({ command: 'copyToClipboard', text: details });
    });
    document.getElementById('inspectDelete').addEventListener('click', () => {
      hideInspector();
      if (!inspectorTaskId) return;
      const ok = confirm('Delete this task?');
      if (!ok) return;
      tasks = tasks.filter(t => t.id !== inspectorTaskId);
      inspectorTaskId = null;
      renderCalendar();
      saveToExtension();
    });

    // request tasks
    vscode.postMessage({ command: 'requestTasks' });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg || !msg.command) return;
      if (msg.command === 'loadTasks') {
        tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
        renderCalendar();
        // Ask extension to (re)schedule reminders for tasks that have reminders - extension may prefer to schedule
        tasks.forEach(t => {
          if (t.reminderMinutes && t.time) {
            const reminderTimestamp = computeReminderTimestamp(t.date, t.time, Number(t.reminderMinutes));
            if (reminderTimestamp) {
              vscode.postMessage({ command: 'scheduleReminder', task: t, reminderAt: reminderTimestamp });
            }
          }
        });
      }
    });

    // hide inspector on outside click
    document.addEventListener('click', (e) => {
      const ins = document.getElementById('inspector');
      if (!ins) return;
      if (!ins.contains(e.target)) ins.hidden = true;
    });
  }

  function changeMonth(delta) {
    shownMonth += delta;
    if (shownMonth < 0) { shownMonth = 11; shownYear--; }
    if (shownMonth > 11) { shownMonth = 0; shownYear++; }
    renderCalendar();
  }

  function renderCalendar() {
    const cal = document.getElementById('calendar');
    cal.innerHTML = '';

    const first = new Date(shownYear, shownMonth, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(shownYear, shownMonth + 1, 0).getDate();
    document.getElementById('monthLabel').textContent = first.toLocaleString(undefined, { month: 'long', year: 'numeric' });

    // previous tail
    const prevDays = startDay;
    const prevMonthDays = new Date(shownYear, shownMonth, 0).getDate();
    for (let i = prevMonthDays - prevDays + 1; i <= prevMonthDays; i++) {
      const el = document.createElement('div');
      el.className = 'day other';
      el.innerHTML = `<div class="date-num faint">${i}</div>`;
      cal.appendChild(el);
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${shownYear}-${String(shownMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayEl = document.createElement('div');
      dayEl.className = 'day';
      dayEl.setAttribute('data-date', dateStr);

      if (dateStr === todayStr) dayEl.classList.add('today');

      const header = document.createElement('div');
      header.className = 'date-num';
      header.innerHTML = `<strong>${d}</strong>`;
      dayEl.appendChild(header);

      const taskWrap = document.createElement('div');
      taskWrap.className = 'tasks';

      const tasksForDay = tasks
        .filter(t => t.date === dateStr)
        .sort((a,b) => (a.time||'') < (b.time||'') ? -1 : (a.time||'') > (b.time||'') ? 1 : 0);

      tasksForDay.slice(0, 5).forEach(t => {
        const tEl = document.createElement('div');
        tEl.className = 'task';
        tEl.setAttribute('draggable', 'true');
        tEl.dataset.taskId = t.id;

        tEl.textContent = (t.time ? `${t.time} — ` : '') + t.title;
        tEl.title = (t.time ? `${t.time} — ` : '') + (t.notes || '');

        // classes for priority or custom color
        if (t.priority === 'high') tEl.classList.add('priority-high');
        else if (t.priority === 'medium') tEl.classList.add('priority-medium');
        else if (t.priority === 'low') tEl.classList.add('priority-low');
        else if (t.color) {
          tEl.classList.add('custom');
          tEl.style.setProperty('--task-color', t.color);
        }

        // click to edit
        tEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openModalForEdit(t.id);
        });

        // right-click -> show inspector context menu
        tEl.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          showInspectorAt(ev.clientX, ev.clientY, t.id);
        });

        // dragstart
        tEl.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', t.id);
          ev.dataTransfer.effectAllowed = 'move';
          // small visual cue
          setTimeout(() => tEl.classList.add('dragging'), 0);
        });
        tEl.addEventListener('dragend', () => {
          tEl.classList.remove('dragging');
        });

        taskWrap.appendChild(tEl);
      });

      if (tasksForDay.length > 5) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `+${tasksForDay.length - 5} more`;
        taskWrap.appendChild(more);
      }

      dayEl.appendChild(taskWrap);

      // drop handling to support drag & drop of tasks into this day
      dayEl.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        dayEl.classList.add('drop-target');
        ev.dataTransfer.dropEffect = 'move';
      });
      dayEl.addEventListener('dragleave', (ev) => {
        dayEl.classList.remove('drop-target');
      });
      dayEl.addEventListener('drop', (ev) => {
        ev.preventDefault();
        dayEl.classList.remove('drop-target');
        const taskId = ev.dataTransfer.getData('text/plain');
        if (!taskId) return;
        const tIdx = tasks.findIndex(x => x.id === taskId);
        if (tIdx < 0) return;
        // update date
        tasks[tIdx].date = dateStr;
        // if time empty, keep; if reminder exists, reschedule via host
        renderCalendar();
        saveToExtension();
      });

      // double-click to create task for date
      dayEl.addEventListener('dblclick', () => openModal(dateStr));

      cal.appendChild(dayEl);
    }

    // fill trailing cells
    const totalCells = cal.children.length;
    const toAdd = (7 * Math.ceil(totalCells / 7)) - totalCells;
    for (let i = 1; i <= toAdd; i++) {
      const el = document.createElement('div');
      el.className = 'day other';
      el.innerHTML = `<div class="date-num faint">${i}</div>`;
      cal.appendChild(el);
    }
  }

  // inspector UI
  function showInspectorAt(x, y, taskId) {
    const ins = document.getElementById('inspector');
    inspectorTaskId = taskId;
    document.getElementById('inspectorTitle').textContent = (tasks.find(t => t.id === taskId) || {}).title || 'Task';
    ins.style.left = `${x}px`;
    ins.style.top = `${y}px`;
    ins.hidden = false;
    // store id for buttons
    inspectorTaskId = taskId;
  }
  function hideInspector() {
    const ins = document.getElementById('inspector');
    if (ins) ins.hidden = true;
    inspectorTaskId = null;
  }

  // open modal for new task
  function openModal(prefillDate) {
    editingTaskId = null;
    const modal = document.getElementById('modal');
    modal.hidden = false;
    const dateInput = document.getElementById('taskDate');
    const titleInput = document.getElementById('taskTitle');
    const notesInput = document.getElementById('taskNotes');
    const prioritySel = document.getElementById('taskPriority');
    const colorInput = document.getElementById('taskColor');
    const timeInput = document.getElementById('taskTime');
    const reminderInput = document.getElementById('taskReminder');

    dateInput.value = prefillDate || new Date().toISOString().slice(0,10);
    titleInput.value = '';
    notesInput.value = '';
    timeInput.value = '';
    prioritySel.value = '';
    colorInput.value = '#3b82f6';
    reminderInput.value = '';

    document.getElementById('deleteTaskBtn').style.display = 'none';
  }

  // open modal to edit
  function openModalForEdit(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    editingTaskId = id;
    const modal = document.getElementById('modal');
    modal.hidden = false;

    document.getElementById('taskDate').value = t.date || new Date().toISOString().slice(0,10);
    document.getElementById('taskTitle').value = t.title || '';
    document.getElementById('taskNotes').value = t.notes || '';
    document.getElementById('taskTime').value = t.time || '';
    document.getElementById('taskPriority').value = t.priority || '';
    document.getElementById('taskColor').value = t.color || '#3b82f6';
    document.getElementById('taskReminder').value = t.reminderMinutes || '';

    document.getElementById('deleteTaskBtn').style.display = ''; // show
  }

  function saveTaskFromModal() {
    const title = document.getElementById('taskTitle').value.trim();
    const date = document.getElementById('taskDate').value;
    const notes = document.getElementById('taskNotes').value.trim();
    const priority = document.getElementById('taskPriority').value || undefined;
    const color = document.getElementById('taskColor').value || undefined;
    const time = document.getElementById('taskTime').value || undefined;
    const reminderMinutesRaw = document.getElementById('taskReminder').value;
    const reminderMinutes = reminderMinutesRaw ? Number(reminderMinutesRaw) : undefined;

    if (!title || !date) {
      alert('Please provide title and date');
      return;
    }

    if (editingTaskId) {
      const idx = tasks.findIndex(t => t.id === editingTaskId);
      if (idx >= 0) {
        tasks[idx] = Object.assign({}, tasks[idx], { title, date, notes, priority, color, time, reminderMinutes });
        // ask host to (re)schedule/cancel reminder as needed
        manageReminderForTask(tasks[idx]);
      }
    } else {
      const newTask = { id: Date.now().toString(), title, date, notes, priority, color, time, reminderMinutes };
      tasks.push(newTask);
      manageReminderForTask(newTask);
    }

    closeModal();
    renderCalendar();
    saveToExtension();
  }

  function deleteTaskFromModal() {
    if (!editingTaskId) return;
    const ok = confirm('Delete this task?');
    if (!ok) return;
    // cancel reminder if any
    vscode.postMessage({ command: 'cancelReminder', taskId: editingTaskId });
    tasks = tasks.filter(t => t.id !== editingTaskId);
    editingTaskId = null;
    closeModal();
    renderCalendar();
    saveToExtension();
  }

  function closeModal() {
    document.getElementById('modal').hidden = true;
    editingTaskId = null;
  }

  function saveToExtension() {
    vscode.postMessage({ command: 'saveTasks', tasks });
  }

  // helper to schedule/cancel reminder for a task by asking extension host
  function manageReminderForTask(task) {
    // always cancel existing first
    if (task && task.id) {
      vscode.postMessage({ command: 'cancelReminder', taskId: task.id });
    }
    if (task && task.reminderMinutes && task.time) {
      const ts = computeReminderTimestamp(task.date, task.time, Number(task.reminderMinutes));
      if (ts) {
        vscode.postMessage({ command: 'scheduleReminder', task: task, reminderAt: ts });
      }
    }
  }

  // compute absolute timestamp ms for reminder given date 'YYYY-MM-DD', time 'HH:MM' and minutes before
  function computeReminderTimestamp(dateStr, timeStr, minutesBefore) {
    try {
      // combine into local datetime
      const [y,m,d] = dateStr.split('-').map(Number);
      const [hh,mm] = timeStr.split(':').map(Number);
      const dt = new Date(y, m-1, d, hh || 0, mm || 0, 0);
      const remindAt = dt.getTime() - (minutesBefore * 60 * 1000);
      if (isNaN(remindAt)) return null;
      return remindAt;
    } catch (e) {
      return null;
    }
  }

  // initialize
  start();
})();
