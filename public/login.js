const form = document.querySelector('#loginForm');
const password = document.querySelector('#password');
const button = document.querySelector('#loginButton');
const error = document.querySelector('#loginError');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Logging in...';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: password.value }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Login failed');

    window.location.assign('/');
  } catch (loginError) {
    error.textContent = loginError.message;
    password.select();
  } finally {
    button.disabled = false;
    button.textContent = 'Log in';
  }
});
