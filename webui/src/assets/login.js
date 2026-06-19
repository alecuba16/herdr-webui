login.onsubmit = async (e) => {
  e.preventDefault();
  error.textContent = "";
  const f = new FormData(login);
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: f.get("username"),
      password: f.get("password"),
    }),
  });
  if (r.ok) location.reload();
  else error.textContent = "login failed";
};
