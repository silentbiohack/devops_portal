(function () {
  const translations = {
    ru: {
      allArticles: '← Все статьи',
      backHome: '← На главную',
      toAll: 'Ко всем статьям',
      copyLink: 'Скопировать ссылку',
      copied: 'Ссылка скопирована!',
      related: 'Похожие материалы',
      noRelated: 'Пока нет похожих статей в этой категории.',
      shareHint: 'Статья полезна? Поделитесь с коллегами.',
      suggestTopic: 'Хотите предложить тему — напишите редакции.',
      articleFooter: 'DevOps News — образовательный проект. Материалы обновляются через закрытую редакторскую панель.',
      notFound: 'Страница не найдена',
      themeLight: 'Светлая тема',
      themeDark: 'Темная тема'
    },
    kk: {
      allArticles: '← Барлық мақалалар',
      backHome: '← Басты бетке',
      toAll: 'Барлық мақалаларға',
      copyLink: 'Сілтемені көшіру',
      copied: 'Сілтеме көшірілді!',
      related: 'Ұқсас материалдар',
      noRelated: 'Бұл санатта ұқсас мақалалар әзірге жоқ.',
      shareHint: 'Мақала пайдалы ма? Әріптестеріңізбен бөлісіңіз.',
      suggestTopic: 'Тақырып ұсынғыңыз келсе, редакцияға жазыңыз.',
      articleFooter: 'DevOps News — білім беру жобасы. Материалдар жабық редакторлық панель арқылы жаңартылады.',
      notFound: 'Бет табылмады',
      themeLight: 'Жарық тема',
      themeDark: 'Қараңғы тема'
    }
  };

  let currentLang = localStorage.getItem('devops-lang') || 'ru';
  let currentTheme = localStorage.getItem('devops-theme') || 'light';

  function t(key) {
    return (translations[currentLang] && translations[currentLang][key]) || translations.ru[key] || key;
  }

  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem('devops-theme', currentTheme);
    document.documentElement.dataset.theme = currentTheme;

    const button = document.getElementById('site-theme-toggle');
    if (button) {
      const isDark = currentTheme === 'dark';
      button.innerHTML = `<i class="fa-solid ${isDark ? 'fa-sun' : 'fa-moon'}"></i>`;
      button.setAttribute('aria-label', isDark ? t('themeLight') : t('themeDark'));
      button.setAttribute('title', isDark ? t('themeLight') : t('themeDark'));
    }
  }

  function applyLang(lang) {
    currentLang = lang === 'kk' ? 'kk' : 'ru';
    localStorage.setItem('devops-lang', currentLang);
    document.documentElement.lang = currentLang === 'kk' ? 'kk' : 'ru';

    document.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = t(element.dataset.i18n);
    });

    document.querySelectorAll('[data-lang-option]').forEach(button => {
      button.classList.toggle('active', button.dataset.langOption === currentLang);
    });

    applyTheme(currentTheme);
  }

  window.copyArticleLink = function () {
    navigator.clipboard.writeText(window.location.href).then(() => alert(t('copied')));
  };

  window.SitePrefs = { t, applyLang, applyTheme };

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme);
    applyLang(currentLang);

    document.querySelectorAll('[data-lang-option]').forEach(button => {
      button.addEventListener('click', () => applyLang(button.dataset.langOption));
    });

    const themeButton = document.getElementById('site-theme-toggle');
    if (themeButton) {
      themeButton.addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));
    }
  });
})();
