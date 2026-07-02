/**
 * 对点咨询 校招管理系统 - 通用 JS
 * API Client, Auth, Toast, Utils
 */

const API_BASE = '';

// ==================== Storage ====================
const Storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('rcs_' + key)); }
    catch { return null; }
  },
  set(key, val) {
    localStorage.setItem('rcs_' + key, JSON.stringify(val));
  },
  remove(key) {
    localStorage.removeItem('rcs_' + key);
  }
};

// ==================== API Client ====================
async function api(path, options = {}) {
  const token = Storage.get('token');
  const headers = { ...options.headers };

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  const res = await fetch(API_BASE + path, {
    ...options,
    headers
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) {
      Storage.remove('token');
      Storage.remove('user');
      // 重载当前页面，各自页面的 init() 会显示对应的登录表单
      window.location.reload();
      throw new Error('登录已过期，请重新登录');
    }
    if (res.status === 403) {
      // 角色不匹配：清除缓存，引导用户重新登录
      Storage.remove('token');
      Storage.remove('user');
      window.location.reload();
      throw new Error('权限不足，请使用正确的账号登录');
    }
    throw new Error(data.error || '请求失败');
  }

  return data;
}

const apiClient = {
  get: (path) => api(path),
  post: (path, data) => api(path, { method: 'POST', body: data instanceof FormData ? data : JSON.stringify(data) }),
  put: (path, data) => api(path, { method: 'PUT', body: data instanceof FormData ? data : JSON.stringify(data) }),
  delete: (path) => api(path, { method: 'DELETE' })
};

// ==================== Toast ====================
function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ==================== Theme ====================
function initTheme() {
  const saved = Storage.get('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  Storage.set('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ==================== Auth ====================
function isLoggedIn() {
  return !!Storage.get('token');
}

function getUser() {
  return Storage.get('user');
}

function logout() {
  Storage.remove('token');
  Storage.remove('user');
  window.location.href = '/';
}

// ==================== Phone Verification ====================
let countdownTimer = null;

function startCountdown(btn, seconds = 60) {
  btn.disabled = true;
  let remaining = seconds;

  const originalText = btn.textContent;
  btn.textContent = `${remaining}s 后重发`;

  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      btn.disabled = false;
      btn.textContent = originalText;
    } else {
      btn.textContent = `${remaining}s 后重发`;
    }
  }, 1000);
}

async function sendVerificationCode(phone, btn) {
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    showToast('请输入正确的手机号', 'error');
    return false;
  }

  try {
    const data = await apiClient.post('/api/auth/send-code', { phone });
    if (data.code) {
      showToast(`验证码: ${data.code}`, 'info');
    } else {
      showToast('验证码已发送', 'success');
    }
    startCountdown(btn);
    return true;
  } catch (e) {
    showToast(e.message, 'error');
    return false;
  }
}

// ==================== Format Utils ====================
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ==================== Handle Enter Key ====================
function handleEnterKey(event, callback) {
  if (event.key === 'Enter') callback();
}

// ==================== Init ====================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
});
