// Auth client — same origin as website
const AUTH_URL = window.location.origin;

async function authFetch(path, options = {}) {
  const res = await fetch(`${AUTH_URL}/api/auth${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) return null;
  return res.json();
}

export async function getSession() {
  return authFetch('/get-session');
}

export async function signInWith(provider) {
  const callbackURL = window.location.href;
  const res = await fetch(`${AUTH_URL}/api/auth/sign-in/social`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, callbackURL }),
  });
  const data = await res.json();
  if (data?.url) {
    window.location.href = data.url;
  }
}

export async function signOut() {
  await authFetch('/sign-out', { method: 'POST' });
  window.location.reload();
}

// --- UI rendering ---

function createProviderButton(provider, label, svgIcon) {
  return `<button class="auth-provider-btn" onclick="window.__signInWith('${provider}')">
    ${svgIcon}<span>${label}</span>
  </button>`;
}

const PROVIDERS = {
  google: {
    label: 'Google',
    icon: `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`,
  },
  twitter: {
    label: 'X',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  },
  discord: {
    label: 'Discord',
    icon: `<svg width="18" height="14" viewBox="0 0 71 55" fill="none"><path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.8 40.8 0 00-1.8 3.7 54 54 0 00-16.2 0A37.4 37.4 0 0025.4.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.5 4.9a.2.2 0 00-.1.1C1.5 18.7-.9 32.2.3 45.5v.1a58.8 58.8 0 0017.7 9a.2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.8 38.8 0 01-5.5-2.6.2.2 0 01 0-.4l1.1-.9a.2.2 0 01.2 0 42 42 0 0035.6 0 .2.2 0 01.2 0l1.1.9a.2.2 0 010 .4 36.4 36.4 0 01-5.5 2.6.2.2 0 00-.1.3 47.2 47.2 0 003.6 5.9.2.2 0 00.3.1 58.6 58.6 0 0017.7-9v-.1c1.4-15.2-2.4-28.4-10-40.1a.2.2 0 00-.1-.1zM23.7 37.3c-3.5 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7zm23.3 0c-3.5 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.2 6.3 7-2.8 7-6.3 7z" fill="#5865F2"/></svg>`,
  },
  linkedin: {
    label: 'LinkedIn',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
  },
};

export function renderAuthUI() {
  const container = document.getElementById('authContainer');
  if (!container) return;

  // Check session
  getSession().then(session => {
    if (session?.user) {
      const name = session.user.name || session.user.email;
      const img = session.user.image;
      container.innerHTML = `
        <div class="auth-user-info">
          ${img ? `<img src="${img}" alt="" class="auth-avatar">` : ''}
          <span class="auth-user-name">${name}</span>
          <button class="auth-signout-btn" onclick="window.__signOut()">Sign Out</button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="auth-signin-wrapper">
          <button class="auth-signin-btn" onclick="this.parentElement.querySelector('.auth-dropdown').classList.toggle('open')">Sign In</button>
          <div class="auth-dropdown" id="authDropdown">
            ${Object.entries(PROVIDERS).map(([id, p]) => createProviderButton(id, p.label, p.icon)).join('')}
          </div>
        </div>
      `;
    }
  }).catch(() => {
    // Auth server unavailable — hide the auth container
    container.style.display = 'none';
  });
}

// Expose to global scope for onclick handlers
window.__signInWith = signInWith;
window.__signOut = signOut;

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('authDropdown');
  if (!dropdown) return;
  const wrapper = dropdown.closest('.auth-signin-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderAuthUI);
} else {
  renderAuthUI();
}
