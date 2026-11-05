try {
  document.documentElement.classList.toggle("dark", localStorage.getItem("ferto-theme") !== "light");
} catch {
  // The default theme still works when browser storage is unavailable.
}
