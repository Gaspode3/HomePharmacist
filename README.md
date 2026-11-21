# Домашній фармацевт

Сімейна домашня аптечка: що є вдома, що протерміновано, і чи є вдома ліки з тією ж діючою речовиною, що й у призначенні лікаря.

- Сайт — GitHub Pages, дані й вхід — Firebase (безкоштовний план Spark).
- Рідні входять своїм Google-акаунтом; доступ лише в адрес, яких додав власник аптечки.
- Сканування штрих-коду / GS1 DataMatrix камерою наживо (з DataMatrix — точний термін придатності), зчитування дати з фото (OCR у браузері), вбудований довідник «торгова назва → МНН».
- Працює офлайн, встановлюється на головний екран телефону.

## Налаштування (один раз)

### 1. Firebase
1. https://console.firebase.google.com → **Add project** (Google Analytics можна вимкнути).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable** (вкажіть свою пошту підтримки) → Save.
3. **Authentication → Settings → Authorized domains → Add domain**: `gaspode3.github.io`.
4. **Build → Firestore Database → Create database** → регіон `eur3 (europe-west)` → *Start in production mode*.
5. **Firestore → Rules** → вставте вміст файлу [`firestore.rules`](firestore.rules) → **Publish**.
6. **Project settings (⚙️) → General → Your apps → Web (`</>`)** → назва «Аптечка» (Hosting не потрібен) → скопіюйте об'єкт `firebaseConfig` у [`js/firebase-config.js`](js/firebase-config.js).

### 2. GitHub Pages
**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`** → Save.
Через хвилину сайт буде на `https://gaspode3.github.io/HomePharmacist/`.

### 3. Перший вхід
1. Відкрийте сайт, увійдіть через Google → **Створити нову аптечку** (ви — власник).
2. **⋯ → Сім'я** → додайте Gmail-адреси рідних → надішліть їм посилання.
3. На телефоні: Chrome → меню → «Додати на головний екран» (iPhone: Safari → Поділитися → «На початковий екран»).

Перенести ліки з версії в Claude: там **⋯ → Скопіювати JSON**, тут **⋯ → Імпорт**.

## Структура
| Файл | Що робить |
|---|---|
| `index.html`, `css/app.css` | інтерфейс |
| `js/app.js` | логіка: список, форма, призначення, сім'я |
| `js/store.js` | **уся** робота з Firebase (замінити базу = переписати лише цей файл) |
| `js/scan.js` | штрих-коди, DataMatrix (GS1), OCR дати |
| `js/drugs.js` | довідник препаратів (доповнюйте) |
| `firestore.rules` | правила доступу до даних |
| `sw.js`, `manifest.webmanifest` | офлайн і встановлення на телефон |

## Модель даних (Firestore)
```
households/{hid}            { name, owner, ownerEmail, members: [email] }
households/{hid}/meds/{id}  { name, inn[], innLatin[], strength, form, lots: [{ expiry, qty }], expiry: найближчий термін,
                              qty, category, location, notes, barcode, addedAt, addedBy, updatedAt, updatedBy }
households/{hid}/barcodes/{code}  { name, inn[], innLatin[], strength, form, category }
invites/{email}             { hid }
```
Термін лише з місяцем означає «до кінця місяця».

> Підказки додатку не замінюють лікаря чи фармацевта.
