const mobileMenu = document.querySelector('.mobile-menu');
mobileMenu.addEventListener('click', (event) => {
  if (event.target.closest('a')) mobileMenu.open = false;
});
mobileMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && mobileMenu.open) {
    mobileMenu.open = false;
    mobileMenu.querySelector('summary').focus();
  }
});
