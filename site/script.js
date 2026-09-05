const revealItems = document.querySelectorAll('.reveal');

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.style.animationPlayState = 'running';
      currentObserver.unobserve(entry.target);
    });
  }, { threshold: 0.12 });
  revealItems.forEach((item) => {
    if (!item.classList.contains('reveal-one') && !item.classList.contains('reveal-two') && !item.classList.contains('reveal-three')) {
      item.style.animationPlayState = 'paused';
    }
    observer.observe(item);
  });
}

const currentYear = new Date().getFullYear();
const footer = document.querySelector('.footer');
if (footer) footer.setAttribute('data-year', String(currentYear));
