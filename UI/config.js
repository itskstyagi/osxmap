// Set window.MONUMENT_API_URL before app.js, or use ?api=https://api.example.com.
const suppliedUrl = new URLSearchParams(window.location.search).get('api') || window.MONUMENT_API_URL || localStorage.getItem('monument-api-url');

export const API_BASE_URL = (suppliedUrl || 'http://127.0.0.1:8787').replace(/\/$/, '');

export function apiPath(path) {
  return `${API_BASE_URL}${path}`;
}
