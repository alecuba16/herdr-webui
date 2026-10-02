// Show/hide the password while typing (toggle button inside the field).
const loginForm = document.getElementById("login");
const passwordInput = document.getElementById("password");
const passwordToggle = document.getElementById("passwordToggle");
const errorMessage = document.getElementById("error");
const loginSubmit = document.getElementById("loginSubmit");

passwordToggle.onclick = () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  passwordToggle.textContent = show ? "🙈" : "👁";
  passwordToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
  passwordToggle.setAttribute("aria-pressed", show ? "true" : "false");
  passwordToggle.title = show ? "Hide password" : "Show password";
  passwordInput.focus();
};
loginForm.onsubmit = async (e) => {
  e.preventDefault();
  errorMessage.textContent = "";
  // Busy state (spinner + disabled) while the login request is in flight so
  // the wait for the backend is visible instead of a frozen-looking form.
  loginSubmit.disabled = true;
  loginSubmit.classList.add("busy");
  loginSubmit.innerHTML = '<span class="login-spinner" aria-hidden="true"></span> Signing in...';
  try {
    const f = new FormData(loginForm);
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: f.get("username"),
        password: f.get("password"),
      }),
    });
    if (r.ok) location.reload();
    else errorMessage.textContent = "login failed";
  } catch (_) {
    errorMessage.textContent = "login failed";
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.classList.remove("busy");
    loginSubmit.textContent = "Login";
  }
};
