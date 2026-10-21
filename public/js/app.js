document.querySelectorAll(".flash").forEach((el) => {
  setTimeout(() => el.classList.add("hidden"), 5000);
});
