// Thin wrapper over fetch for the PM API. All endpoints return JSON; errors throw.

const API = {
  base: 'api',

  async request(path, opts = {}) {
    const hasBody = Object.prototype.hasOwnProperty.call(opts, 'body');
    const isFormData = hasBody && (opts.body instanceof FormData);
    const res = await fetch(`${this.base}/${path}`, {
      credentials: 'same-origin',
      headers: isFormData
        ? { 'Accept': 'application/json' }
        : { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      ...opts,
    });
    let body, parseOk = true;
    try { body = await res.json(); } catch { body = {}; parseOk = false; }
    // Session expired mid-use → bounce to login (but only after the app has
    // booted, so a boot-time 401 can't cause a redirect loop, and never while
    // already on the login page). The initial auth check handles the not-yet-
    // logged-in case separately.
    if (res.status === 401 && window.__pmBooted && !/login\.html$/.test(location.pathname)) {
      try { location.href = 'login.html'; } catch (_) {}
    }
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    // A 200 whose body didn't parse as JSON almost always means a PHP fatal
    // emitted an HTML error page — surface it instead of returning {} (which
    // silently produces a blank app when destructured downstream).
    if (!parseOk) {
      throw new Error('The server returned an unexpected (non-JSON) response.');
    }
    return body;
  },

  get(path)         { return this.request(path, { method: 'GET' }); },
  post(path, body)  { return this.request(path, { method: 'POST', body: JSON.stringify(body || {}) }); },
  patch(path, body) { return this.request(path, { method: 'PATCH', body: JSON.stringify(body || {}) }); },
  put(path, body)   { return this.request(path, { method: 'PUT', body: JSON.stringify(body || {}) }); },
  del(path)         { return this.request(path, { method: 'DELETE' }); },

  // ---- auth ----
  me()                     { return this.get('auth.php?action=me'); },
  login(email, password)   { return this.post('auth.php?action=login', { email, password }); },
  logout()                 { return this.post('auth.php?action=logout', {}); },
  register(data)           { return this.post('auth.php?action=register', data); },
  updateProfile(data)      { return this.post('auth.php?action=update_profile', data); },

  // ---- bundle: load everything the app needs on boot ----
  async bootstrap() {
    const [me, projects, labels, users, tasks] = await Promise.all([
      this.me(),
      this.get('projects.php'),
      this.get('labels.php'),
      this.get('users.php'),
      this.get('tasks.php'),
    ]);
    return {
      me:       me.user,
      projects: projects.projects,
      labels:   labels.labels,
      users:    users.users,
      tasks:    tasks.tasks,
    };
  },

  // ---- tasks ----
  listTasks()               { return this.get('tasks.php'); },
  getTask(id)               { return this.get(`tasks.php?id=${id}`); },
  searchTasks(opts = {}) {
    const p = new URLSearchParams({ search: '1' });
    for (const k of ['q', 'project', 'status', 'assignee', 'label', 'limit', 'offset']) {
      if (opts[k] != null && opts[k] !== '') p.set(k, opts[k]);
    }
    return this.get('tasks.php?' + p.toString());
  },
  createTask(data)          { return this.post('tasks.php', data); },
  updateTask(id, patch)     { return this.patch(`tasks.php?id=${id}`, patch); },
  deleteTask(id)            { return this.del(`tasks.php?id=${id}`); },

  addSubtask(taskId, text)  { return this.post(`tasks.php?id=${taskId}&subtasks=1`, { text }); },
  updateSubtask(taskId, subId, patch) { return this.patch(`tasks.php?id=${taskId}&subtask_id=${subId}`, patch); },
  deleteSubtask(taskId, subId)        { return this.del(`tasks.php?id=${taskId}&subtask_id=${subId}`); },

  listComments(taskId)      { return this.get(`tasks.php?id=${taskId}&comments=1`); },
  addComment(taskId, body)  { return this.post(`tasks.php?id=${taskId}&comments=1`, { body }); },
  updateComment(taskId, commentId, body) { return this.patch(`tasks.php?id=${taskId}&comments=1&comment_id=${commentId}`, { body }); },
  deleteComment(taskId, commentId) { return this.del(`tasks.php?id=${taskId}&comments=1&comment_id=${commentId}`); },
  bulkUpdateTasks(taskIds, patch) { return this.patch('tasks.php?bulk=1', { task_ids: taskIds, patch }); },
  listAttachments(taskId) { return this.get(`attachments.php?task_id=${taskId}`); },
  uploadAttachment(taskId, file) {
    const form = new FormData();
    form.append('file', file);
    return this.request(`attachments.php?task_id=${taskId}`, { method: 'POST', body: form });
  },
  deleteAttachment(id) { return this.del(`attachments.php?id=${id}`); },

  // ---- projects ----
  listProjects(opts = {})   {
    const q = opts.onlyActive ? '?only_active=1' : '';
    return this.get('projects.php' + q);
  },
  getProject(id)            { return this.get(`projects.php?id=${id}`); },
  createProject(data)       { return this.post('projects.php', data); },
  updateProject(id, patch)  { return this.patch(`projects.php?id=${id}`, patch); },
  deleteProject(id, force=false) { return this.del(`projects.php?id=${id}${force ? '&force=1' : ''}`); },

  // ---- v2.6: project members & access ----
  listProjectMembers(projectId)             { return this.get(`project_members.php?project_id=${projectId}`); },
  addProjectMember(projectId, userId, role) { return this.post(`project_members.php?project_id=${projectId}`, { user_id: userId, role }); },
  removeProjectMember(projectId, userId)    { return this.del(`project_members.php?project_id=${projectId}&user_id=${userId}`); },
  setProjectVisibility(projectId, visibility) { return this.patch(`project_members.php?project_id=${projectId}`, { visibility }); },

  // ---- labels ----
  listLabels(opts = {})     {
    const parts = [];
    if (opts.includeArchived) parts.push('include_archived=1');
    if (opts.projectId != null) parts.push('project_id=' + opts.projectId);
    return this.get('labels.php' + (parts.length ? '?' + parts.join('&') : ''));
  },
  createLabel(data)         { return this.post('labels.php', data); },
  updateLabel(id, patch)    { return this.patch(`labels.php?id=${id}`, patch); },
  deleteLabel(id, force=false) { return this.del(`labels.php?id=${id}${force ? '&force=1' : ''}`); },

  // ---- slack integration ----
  getSlack()                { return this.get('slack.php'); },
  updateSlack(data)         { return this.post('slack.php?action=save', data); },
  testSlack(channel)        { return this.post('slack.php?action=test', { channel }); },

  // ---- recurring rules ----
  listRecurring()           { return this.get('recurring.php'); },
  createRecurring(data)     { return this.post('recurring.php', data); },
  updateRecurring(id, data) { return this.patch(`recurring.php?id=${id}`, data); },
  deleteRecurring(id)       { return this.del(`recurring.php?id=${id}`); },

  // ---- users (admin) ----
  updateUser(id, patch)     { return this.patch(`users.php?id=${id}`, patch); },
  deleteUser(id)            { return this.del(`users.php?id=${id}`); },

  // ---- misc ----
  listActivity()            { return this.get('activity.php'); },
  activityLog(opts = {}) {
    const p = new URLSearchParams();
    for (const k of ['limit', 'offset', 'user_id', 'task_id', 'action', 'q']) {
      if (opts[k] != null && opts[k] !== '') p.set(k, opts[k]);
    }
    const qs = p.toString();
    return this.get('activity.php' + (qs ? '?' + qs : ''));
  },
  listUsers()               { return this.get('users.php'); },
  listSavedViews()          { return this.get('saved_views.php'); },
  createSavedView(data)     { return this.post('saved_views.php', data); },
  updateSavedView(id, data) { return this.patch(`saved_views.php?id=${id}`, data); },
  deleteSavedView(id)       { return this.del(`saved_views.php?id=${id}`); },

  // ---- v2: notifications ----
  listNotifications()             { return this.get('notifications.php'); },
  unreadCount()                   { return this.get('notifications.php?unread=1'); },
  markNotificationRead(id)        { return this.patch(`notifications.php?id=${id}`, { is_read: true }); },
  markAllNotificationsRead()      { return this.patch('notifications.php?all=1', { is_read: true }); },
  deleteNotification(id)          { return this.del(`notifications.php?id=${id}`); },

  // ---- v2: dependencies ----
  listDependencies(taskId)        { return this.get(`dependencies.php?task_id=${taskId}`); },
  addDependency(taskId, dependsOnId) { return this.post(`dependencies.php?task_id=${taskId}`, { depends_on_id: dependsOnId }); },
  removeDependency(taskId, dependsOnId) { return this.del(`dependencies.php?task_id=${taskId}&depends_on_id=${dependsOnId}`); },

  // ---- v2: time tracking ----
  listTime(taskId)                { return this.get(`time.php?task_id=${taskId}`); },
  addTime(taskId, data)           { return this.post(`time.php?task_id=${taskId}`, data); },
  deleteTime(entryId)             { return this.del(`time.php?id=${entryId}`); },

  // ---- v2: custom fields ----
  listCustomFields()              { return this.get('custom_fields.php'); },
  createCustomField(data)         { return this.post('custom_fields.php', data); },
  updateCustomField(id, patch)    { return this.patch(`custom_fields.php?id=${id}`, patch); },
  deleteCustomField(id)           { return this.del(`custom_fields.php?id=${id}`); },
  setCustomValue(taskId, fieldId, value) { return this.put(`custom_fields.php?task_id=${taskId}&field_id=${fieldId}`, { value }); },

  // ---- v2: milestones ----
  listMilestones()                { return this.get('milestones.php'); },
  createMilestone(data)           { return this.post('milestones.php', data); },
  updateMilestone(id, patch)      { return this.patch(`milestones.php?id=${id}`, patch); },
  deleteMilestone(id)             { return this.del(`milestones.php?id=${id}`); },

  // ---- v2.4: goals / OKRs ----
  listGoals()                     { return this.get('goals.php'); },
  createGoal(data)                { return this.post('goals.php', data); },
  updateGoal(id, patch)           { return this.patch(`goals.php?id=${id}`, patch); },
  deleteGoal(id)                  { return this.del(`goals.php?id=${id}`); },

  // ---- v2: watchers / activity / reactions (task sub-routes) ----
  watchTask(taskId)               { return this.post(`tasks.php?id=${taskId}&watch=1`, {}); },
  unwatchTask(taskId)             { return this.del(`tasks.php?id=${taskId}&watch=1`); },
  taskActivity(taskId)            { return this.get(`tasks.php?id=${taskId}&activity=1`); },
  addReaction(taskId, commentId, emoji)    { return this.post(`tasks.php?id=${taskId}&comments=1&comment_id=${commentId}&reaction=${encodeURIComponent(emoji)}`, {}); },
  removeReaction(taskId, commentId, emoji) { return this.del(`tasks.php?id=${taskId}&comments=1&comment_id=${commentId}&reaction=${encodeURIComponent(emoji)}`); },

  // ---- v2.1: task templates ----
  listTemplates()                 { return this.get('templates.php'); },
  createTemplate(data)            { return this.post('templates.php', data); },
  updateTemplate(id, patch)       { return this.patch(`templates.php?id=${id}`, patch); },
  deleteTemplate(id)              { return this.del(`templates.php?id=${id}`); },

  // ---- v2.1: automation rules ----
  listAutomations()               { return this.get('automations.php'); },
  createAutomation(data)          { return this.post('automations.php', data); },
  updateAutomation(id, patch)     { return this.patch(`automations.php?id=${id}`, patch); },
  deleteAutomation(id)            { return this.del(`automations.php?id=${id}`); },

  // ---- v2.1: reminders ----
  listReminders(taskId)           { return this.get(`reminders.php?task_id=${taskId}`); },
  addReminder(taskId, data)       { return this.post(`reminders.php?task_id=${taskId}`, data); },
  deleteReminder(id)              { return this.del(`reminders.php?id=${id}`); },
};

window.API = API;
