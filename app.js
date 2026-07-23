// EBV Imóveis - Application Business Logic & State Management

// Core Datasets & State (ONLY real properties now with multi-image galleries)
const DEFAULT_PROPERTIES = [
  {
    id: "prop-default-1",
    title: "Sobrado com 4 Quartos - Excelente Acabamento",
    price: 1345000,
    status: "venda",
    type: "sobrado", // apartamento, casa, sobrado, cobertura, terreno
    location: "Jardim das Américas",
    address: "R. Sinke Ferreira, 1050, sobrado 2 - Jardim das Américas",
    area: 156,
    beds: 4,
    baths: 3,
    vagas: 3,
    views: 0,
    waClicks: 0,
    image: "assets/sobrado_real.jpg",
    images: [
      "assets/sobrado_real_00.jpg",
      "assets/sobrado_real_06.jpg",
      "assets/sobrado_real_08.jpg",
      "assets/sobrado_real_09.jpg",
      "assets/sobrado_real_12.jpg",
      "assets/sobrado_real_17.jpg",
      "assets/sobrado_real_18.jpg",
      "assets/sobrado_real_19.jpg",
      "assets/sobrado_real_21.jpg",
      "assets/sobrado_real_22.jpg",
      "assets/sobrado_real_23.jpg",
      "assets/sobrado_real_28.jpg"
    ],
    desc: "Mais do que um imóvel... seu futuro lar cheio de aconchego, charme e boas energias! Este lindo sobrado encanta em cada detalhe: super bem cuidado, com 04 dormitórios sendo 02 suítes. Cozinha sob medida, espaço gourmet com teto retrátil perfeito para viver momentos especiais, além de um ático incrível com 02 ambientes e suíte. E para completar: garagem para até 03 carros. Para quem deseja morar bem! Sua casa com conforto, espaço e aquele sentimento gostoso de 'quero viver aqui'. Ref: 26001/ebv."
  },
  {
    id: "prop-default-2",
    title: "Excelente Terreno (ZR3) em Rua Plana - Cajuru",
    price: 690000,
    status: "venda",
    type: "terreno",
    location: "Cajuru",
    address: "R. Argélia, 433 - Cajuru",
    area: 492,
    beds: 0,
    baths: 0,
    vagas: 0,
    views: 0,
    waClicks: 0,
    image: "assets/terreno_real.jpg",
    images: [
      "assets/terreno_real.jpg"
    ],
    desc: "Excelente terreno ZR3 com 492m² localizado no bairro Cajuru, em rua plana, a apenas 200 metros da BR-277. Próximo ao Terminal Centenário, Mercado Regional do Cajuru, mercados, farmácias, panificadoras e bancos. Escolas públicas e particulares, faculdades e centros de ensino, unidades de saúde e demais serviços essenciais. Fácil acesso ao Centro de Curitiba, litoral paranaense, Aeroporto Internacional Afonso Pena e principais vias da cidade. Potencial construtivo ideal para empreendimentos residenciais com viabilidade para até 4 sobrados ou de 8 a 12 apartamentos. Ref: 26002/ebv."
  },
  {
    id: "prop-default-jba-1",
    title: "Sobrado Novo 3 Quartos - Residencial Harmonia",
    price: 847000,
    status: "venda",
    type: "sobrado",
    location: "Uberaba",
    address: "Rua Mário Bueno Sobrinho - Uberaba",
    area: 124,
    beds: 3,
    baths: 4,
    vagas: 2,
    views: 0,
    waClicks: 0,
    image: "assets/uberaba_real_00.jpg",
    images: [
      "assets/uberaba_real_00.jpg",
      "assets/uberaba_real_01.jpg",
      "assets/uberaba_real_02.jpg",
      "assets/uberaba_real_03.jpg",
      "assets/uberaba_real_04.jpg",
      "assets/uberaba_real_05.jpg",
      "assets/uberaba_real_06.jpg",
      "assets/uberaba_real_07.jpg",
      "assets/uberaba_real_08.jpg",
      "assets/uberaba_real_09.jpg",
      "assets/uberaba_real_10.jpg",
      "assets/uberaba_real_11.jpg",
      "assets/uberaba_real_12.jpg",
      "assets/uberaba_real_13.jpg",
      "assets/uberaba_real_14.jpg",
      "assets/uberaba_real_15.jpg",
      "assets/uberaba_real_16.jpg",
      "assets/uberaba_real_17.jpg"
    ],
    desc: "Residencial Harmonia. Excelente oportunidade para adquirir um sobrado novo, situado na divisa entre os bairros Uberaba e Jardim das Américas. O condomínio conta com 5 unidades sendo 1 externa com 123m² de área privativa, e 4 internas com metragens que variam de 98m² a 103m² de área privativa. Localizado a apenas duas quadras da Avenida das Torres, no sentido centro, o imóvel oferece uma posição estratégica e muita conveniência. Térreo: Sala ampla, para 2 ambientes; Cozinha; Área de serviço; Lavabo. 2° pavimento: 3 quartos, sendo 1 suíte com sacada; Banheiro social. Diferenciais: O empreendimento conta com acabamento primoroso, todas as unidades serão entregues com porcelanato nas áreas sociais e úmidas, pontos para ar-condicionado na sala e quartos, esquadrias em alumínio e sistema de aquecimento de água a gás ou elétrico. Ref: 26003/ebv."
  },
  {
    id: "prop-default-jba-2",
    title: "Apartamento 2 Quartos - Edifício Garden Sevilha",
    price: 555000,
    status: "venda",
    type: "apartamento",
    location: "Boa Vista",
    address: "Rua Jovino do Rosário - Boa Vista",
    area: 59,
    beds: 2,
    baths: 1,
    vagas: 1,
    views: 0,
    waClicks: 0,
    image: "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/i39oO196FoR77q_6330041006a42d488354b4.jpg",
    images: [
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/i39oO196FoR77q_6330041006a42d488354b4.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a74fbb47546.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a74fc82fb2d.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a74fd4b63eb.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a74fe1836f5.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a74fed293fa.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a74ff897791.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a75002eaaad.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a7500d7e13f.jpg",
      "https://rocketstatic.com.br/media/jbaimoveis/imo-fotos/633004100/im18uI9_63300410069a750174a035.jpg"
    ],
    desc: "Edifício Garden Sevilha. Excelente oportunidade no Boa Vista. Apartamento ideal para quem busca praticidade, conforto e ótima localização. O condomínio oferece estrutura completa de lazer e segurança, situado em uma região estratégica, com fácil acesso ao Centro da cidade e ampla infraestrutura ao redor. Características do imóvel: 59m² de área privativa; 2 quartos bem distribuídos; Banheiro social; Sala de estar e jantar; Sacada; Cozinha planejada; 1 vaga de garagem coberta. Condomínio com lazer completo: Academia equipada, bicicletário, brinquedoteca, churrasqueira coletiva, cinema, piscina aquecida, quadra de tênis, quadra poliesportiva, sala de jogos, salão de festas, sauna, solarium e portaria 24 horas. Estrutura moderna e completa para toda a família! Ref: 26004/ebv."
  }
];

let properties = [];
let appraisals = [];
let targetNavigatePage = null; // Temp storage for navigation when locked

// Modal Photo Gallery State
let currentModalImages = [];
let currentModalPhotoIndex = 0;
let activeModalPropertyId = null; // Global tracker for currently viewed property
let editingPropertyId = null;     // Global tracker for currently edited property

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  loadState();
  renderFeaturedProperties();
  renderCatalogProperties();
  populateSearchFilters();
  checkLgpdConsent();
  updateAdminDashboard();
  setupScrollEffects();
  
  // Close fullscreen viewer when clicking overlay background
  const fViewer = document.getElementById("fullscreen-viewer");
  if (fViewer) {
    fViewer.addEventListener("click", (e) => {
      if (e.target === fViewer) {
        closeFullscreenViewer();
      }
    });
  }
});

// Scroll Event Handler for Header styling
function setupScrollEffects() {
  window.addEventListener("scroll", () => {
    const header = document.getElementById("header");
    if (window.scrollY > 50) {
      header.classList.add("scrolled");
    } else {
      header.classList.remove("scrolled");
    }
  });
}

// LocalStorage State Handlers (with cache migrator to support photo galleries and clean up old data)
function loadState() {
  const localProps = localStorage.getItem("ebv_properties");
  if (localProps) {
    const parsed = JSON.parse(localProps);
    const testProp = parsed.find(p => p.id === "prop-default-jba-1");
    // Trigger reset if old properties exist, or if the JBA Uberaba Sobrado uses remote URLs instead of local copied assets
    const needsMigration = !testProp || !testProp.images || testProp.images.length < 2 || !testProp.image.startsWith("assets/") || parsed.some(p => p.id === "prop-default-3" || p.id === "prop-default-4");
    
    if (needsMigration) {
      properties = [...DEFAULT_PROPERTIES];
      localStorage.setItem("ebv_properties", JSON.stringify(properties));
    } else {
      properties = parsed;
    }
  } else {
    properties = [...DEFAULT_PROPERTIES];
    localStorage.setItem("ebv_properties", JSON.stringify(properties));
  }

  const localAppraisals = localStorage.getItem("ebv_appraisals");
  if (localAppraisals) {
    appraisals = JSON.parse(localAppraisals);
  } else {
    appraisals = [];
    localStorage.setItem("ebv_appraisals", JSON.stringify(appraisals));
  }
}

function saveState() {
  localStorage.setItem("ebv_properties", JSON.stringify(properties));
  localStorage.setItem("ebv_appraisals", JSON.stringify(appraisals));
  populateSearchFilters();
  updateAdminDashboard();
}

// Security & Authentication for Admin Panel
function checkLogin() {
  return sessionStorage.getItem("ebv_logged") === "true";
}

// LGPD Consent Banner Logic
function checkLgpdConsent() {
  const consent = localStorage.getItem("ebv_lgpd_consent");
  const rejected = sessionStorage.getItem("ebv_lgpd_rejected");
  const banner = document.getElementById("lgpd-banner");
  if (!consent && !rejected && banner) {
    setTimeout(() => {
      banner.style.bottom = "20px";
    }, 1500); // Premium delay slide-in
  }
}

function acceptLgpdConsent() {
  localStorage.setItem("ebv_lgpd_consent", "true");
  const banner = document.getElementById("lgpd-banner");
  if (banner) banner.style.bottom = "-250px";
}

function rejectLgpdConsent() {
  sessionStorage.setItem("ebv_lgpd_rejected", "true");
  const banner = document.getElementById("lgpd-banner");
  if (banner) banner.style.bottom = "-250px";
}

function openLoginModal(pageId) {
  targetNavigatePage = pageId;
  document.getElementById("login-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closeLoginModal() {
  document.getElementById("login-modal").style.display = "none";
  document.body.style.overflow = "auto";
  document.getElementById("login-error").style.display = "none";
  document.getElementById("login-form").reset();
}

function submitLogin(event) {
  event.preventDefault();
  const user = document.getElementById("login-username").value.trim();
  const pass = document.getElementById("login-password").value;
  const errorAlert = document.getElementById("login-error");

  // Validate credentials based on LOGIN.txt
  const validUser1 = "akbw.ebv";
  const validPass1 = "Ak123!@#";
  const validUser2 = "contato@ebvimoveiscuritiba.com.br";
  const validPass2 = "Ebv0502!";

  if ((user === validUser1 && pass === validPass1) || (user === validUser2 && pass === validPass2)) {
    sessionStorage.setItem("ebv_logged", "true");
    closeLoginModal();
    if (targetNavigatePage) {
      navigateTo(targetNavigatePage);
    }
  } else {
    errorAlert.style.display = "block";
  }
}

function handleLogout() {
  sessionStorage.removeItem("ebv_logged");
  navigateTo("home");
  alert("Sessão encerrada com sucesso.");
}

// Router & Tabs navigation
function navigateTo(pageId) {
  if (pageId === "admin" && !checkLogin()) {
    openLoginModal(pageId);
    return;
  }

  const pages = document.querySelectorAll(".page");
  pages.forEach(page => {
    page.classList.remove("active");
  });

  const activePage = document.getElementById(`page-${pageId}`);
  if (activePage) {
    activePage.classList.add("active");
  }

  const navLinks = document.querySelectorAll(".nav-link, .nav-btn-admin");
  navLinks.forEach(link => {
    link.classList.remove("active");
  });

  const selectedLink = Array.from(navLinks).find(link => {
    if (pageId === "admin" && link.classList.contains("nav-btn-admin")) return true;
    return link.getAttribute("href") === `#${pageId}`;
  });
  if (selectedLink) {
    selectedLink.classList.add("active");
  }

  window.scrollTo({ top: 0, behavior: "smooth" });

  const navMenu = document.getElementById("nav-menu");
  const mobileToggle = document.querySelector(".mobile-toggle");
  if (navMenu.classList.contains("mobile-active")) {
    navMenu.classList.remove("mobile-active");
    mobileToggle.classList.remove("active");
  }

  if (pageId === "imoveis") {
    renderCatalogProperties();
  }
}

// Toggle Mobile Menu Drawer
function toggleMobileMenu() {
  const navMenu = document.getElementById("nav-menu");
  const mobileToggle = document.querySelector(".mobile-toggle");
  navMenu.classList.toggle("mobile-active");
  mobileToggle.classList.toggle("active");
}

// Format Currency
function formatBRL(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Render Featured Properties on Home Page
function renderFeaturedProperties() {
  const featuredGrid = document.getElementById("featured-grid");
  if (!featuredGrid) return;

  featuredGrid.innerHTML = "";

  // Render first 3 properties as featured on Home Page
  properties.slice(0, 3).forEach(prop => {
    featuredGrid.appendChild(createPropertyCard(prop));
  });
}

// Create Property Card Element
function createPropertyCard(prop) {
  const card = document.createElement("div");
  card.className = "property-card";
  const safeId = escapeHTML(prop.id);
  const safeTitle = escapeHTML(prop.title);
  const safeLocation = escapeHTML(prop.location);
  const safeType = escapeHTML(capitalize(prop.type));
  const safeImage = escapeHTML(prop.image);

  card.innerHTML = `
    <div class="property-img-wrapper" style="cursor: pointer;" onclick="openPropertyModal('${safeId}')" title="Clique para ver detalhes do imóvel">
      <img src="${safeImage}" alt="${safeTitle}" class="property-img" onerror="this.src='assets/sobrado_real.jpg'">
      <span class="property-badge-status">Comprar</span>
      <span class="property-badge-type">${safeType}</span>
    </div>
    <div class="property-info">
      <div class="property-location">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
        <span>${safeLocation}, Curitiba</span>
      </div>
      <h3>${safeTitle}</h3>
      <div class="property-price">${formatBRL(prop.price)}</div>
      <div class="property-features">
        <div class="feature-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
          <span>${Number(prop.area) || 0} m²</span>
        </div>
        <div class="feature-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4v16h20V4H2z"></path><path d="M2 8h20"></path><path d="M6 4v4"></path><path d="M18 4v4"></path></svg>
          <span>${Number(prop.beds) || 0} Qts</span>
        </div>
        <div class="feature-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"></path><path d="M14 3v5h5"></path></svg>
          <span>${Number(prop.baths) || 0} Banheiros/WC</span>
        </div>
      </div>
      <button class="btn-primary" style="margin-top: 20px; width: 100%; justify-content: center;" onclick="openPropertyModal('${safeId}')">Ver Detalhes</button>
    </div>
  `;
  return card;
}

// Capitalize helper
function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Security: HTML Escaping helper to sanitize user-provided values before DOM insertion
function escapeHTML(str) {
  if (typeof str !== "string") return str == null ? "" : String(str);
  return str.replace(/[&<>"']/g, function (m) {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return m;
    }
  });
}

// Dynamically populate search bar filters from current properties list
function populateSearchFilters() {
  const typeSelect = document.getElementById("search-type");
  const locationSelect = document.getElementById("search-location");
  
  if (!typeSelect || !locationSelect) return;
  
  // Extract unique sorted types
  const types = [...new Set(properties.map(p => p.type))].sort();
  // Extract unique sorted locations (neighborhoods)
  const locations = [...new Set(properties.map(p => p.location))].sort();
  
  // Re-populate type select
  const defaultTypeOpt = document.createElement("option");
  defaultTypeOpt.value = "todos";
  defaultTypeOpt.textContent = "Todos os Tipos";
  typeSelect.replaceChildren(defaultTypeOpt);

  types.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = capitalize(t);
    typeSelect.appendChild(opt);
  });
  
  // Re-populate location select
  const defaultLocOpt = document.createElement("option");
  defaultLocOpt.value = "todos";
  defaultLocOpt.textContent = "Todos os Bairros";
  locationSelect.replaceChildren(defaultLocOpt);

  locations.forEach(l => {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    locationSelect.appendChild(opt);
  });
}

// Search queries from Home
function executeQuickSearch() {
  const type = document.getElementById("search-type").value;
  const location = document.getElementById("search-location").value;
  const priceMax = document.getElementById("search-price").value;

  navigateTo("imoveis");
  renderCatalogProperties({
    type,
    location,
    priceMax
  });
}

// Filtering portfolio
function triggerFilters() {
  const keyword = document.getElementById("catalog-keyword").value.toLowerCase();
  const sort = document.getElementById("catalog-sort").value;

  let filtered = properties.filter(prop => {
    if (keyword) {
      const matchText = (prop.title + " " + prop.desc + " " + prop.location + " " + prop.type).toLowerCase();
      if (!matchText.includes(keyword)) return false;
    }
    return true;
  });

  if (sort === "price-asc") {
    filtered.sort((a, b) => a.price - b.price);
  } else if (sort === "price-desc") {
    filtered.sort((a, b) => b.price - a.price);
  } else if (sort === "area-desc") {
    filtered.sort((a, b) => b.area - a.area);
  }

  const catalogGrid = document.getElementById("catalog-grid");
  if (catalogGrid) {
    catalogGrid.replaceChildren();
    if (filtered.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.style.cssText = "grid-column: span 3; text-align: center; padding: 40px; color: var(--text-light);";
      emptyDiv.innerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 15px;"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg><p>Nenhum imóvel encontrado com as opções selecionadas.</p>`;
      catalogGrid.appendChild(emptyDiv);
    } else {
      filtered.forEach(prop => {
        catalogGrid.appendChild(createPropertyCard(prop));
      });
    }
  }
}

// Render dynamic listings in portfolio
function renderCatalogProperties(searchParams = null) {
  const catalogGrid = document.getElementById("catalog-grid");
  if (!catalogGrid) return;

  let filtered = [...properties];

  if (searchParams) {
    if (searchParams.type && searchParams.type !== "todos") {
      filtered = filtered.filter(p => p.type === searchParams.type);
    }
    if (searchParams.location && searchParams.location !== "todos") {
      filtered = filtered.filter(p => p.location.includes(searchParams.location));
    }
    if (searchParams.priceMax && searchParams.priceMax !== "todos") {
      filtered = filtered.filter(p => p.price <= parseFloat(searchParams.priceMax));
    }
  }

  catalogGrid.replaceChildren();
  
  if (filtered.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.style.cssText = "grid-column: span 3; text-align: center; padding: 40px; color: var(--text-light);";
    const emptyP = document.createElement("p");
    emptyP.textContent = "Nenhum imóvel disponível para os filtros selecionados.";
    emptyDiv.appendChild(emptyP);
    catalogGrid.appendChild(emptyDiv);
  } else {
    filtered.forEach(prop => {
      catalogGrid.appendChild(createPropertyCard(prop));
    });
  }
}

// Property Gallery Handlers
function openPropertyModal(id) {
  const prop = properties.find(p => p.id === id);
  if (!prop) return;

  // Track global property modal view
  activeModalPropertyId = id;
  prop.views = (prop.views || 0) + 1;
  saveState();

  // Load photos state
  currentModalImages = prop.images || [prop.image || "assets/sobrado_real.jpg"];
  currentModalPhotoIndex = 0;

  // Set values
  document.getElementById("modal-badge-status").textContent = "COMPRA E VENDA";
  document.getElementById("modal-badge-status").className = `property-badge-status badge-venda`;
  document.getElementById("modal-title-text").textContent = prop.title;
  document.getElementById("modal-location-text").textContent = `${prop.location}, Curitiba`;
  document.getElementById("modal-price-text").textContent = formatBRL(prop.price);
  document.getElementById("modal-spec-area").textContent = prop.area;
  document.getElementById("modal-spec-beds").textContent = prop.beds;
  document.getElementById("modal-spec-baths").textContent = prop.baths;
  document.getElementById("modal-spec-vagas").textContent = prop.vagas || "0";
  document.getElementById("modal-desc-content").textContent = prop.desc;

  // Render photo gallery
  updateModalPhoto();

  // Populate Thumbnails Drawer
  const thumbsContainer = document.getElementById("modal-thumbnails");
  thumbsContainer.innerHTML = "";
  if (currentModalImages.length <= 1) {
    thumbsContainer.style.display = "none";
  } else {
    thumbsContainer.style.display = "flex";
    currentModalImages.forEach((imgSrc, idx) => {
      const thumb = document.createElement("img");
      thumb.src = imgSrc;
      thumb.className = "modal-thumb" + (idx === 0 ? " active" : "");
      thumb.onclick = () => selectModalPhoto(idx);
      thumbsContainer.appendChild(thumb);
    });
  }

  // Load Google Maps Embed dynamically
  const mapIframe = document.getElementById("modal-map-iframe");
  const mapContainer = document.getElementById("modal-map-container");
  const addressText = document.getElementById("modal-address-text");
  
  if (mapContainer && mapIframe && addressText) {
    if (prop.address) {
      mapContainer.style.display = "block";
      addressText.querySelector("span").textContent = `Endereço: ${prop.address}`;
      const mapAddress = prop.address + ", Curitiba - PR";
      mapIframe.src = `https://maps.google.com/maps?q=${encodeURIComponent(mapAddress)}&t=&z=16&ie=UTF8&iwloc=&output=embed`;
    } else {
      mapContainer.style.display = "none";
      mapIframe.src = "";
    }
  }

  // Create WhatsApp Contact Link using real phone from Match 14: (41) 98802-4346
  const phone = "5541988024346";
  const textMessage = encodeURIComponent(`Olá Edicleia! Tenho interesse no imóvel "${prop.title}" (${formatBRL(prop.price)}) que vi no seu site EBV Imóveis. Gostaria de receber mais informações.`);
  document.getElementById("modal-whatsapp-link").href = `https://wa.me/${phone}?text=${textMessage}`;

  // Open Modal
  const modal = document.getElementById("property-modal");
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closePropertyModal() {
  const modal = document.getElementById("property-modal");
  modal.style.display = "none";
  document.body.style.overflow = "auto";
}

function selectModalPhoto(index) {
  currentModalPhotoIndex = index;
  updateModalPhoto();
}

function changeModalPhoto(offset) {
  if (currentModalImages.length <= 1) return;
  currentModalPhotoIndex = (currentModalPhotoIndex + offset + currentModalImages.length) % currentModalImages.length;
  updateModalPhoto();
}

function updateModalPhoto() {
  const modalImg = document.getElementById("modal-image");
  if (modalImg && currentModalImages[currentModalPhotoIndex]) {
    modalImg.src = currentModalImages[currentModalPhotoIndex];
  }

  const thumbs = document.querySelectorAll(".modal-thumb");
  thumbs.forEach((thumb, idx) => {
    if (idx === currentModalPhotoIndex) {
      thumb.classList.add("active");
      thumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    } else {
      thumb.classList.remove("active");
    }
  });
}

// Fullscreen Image Viewer logic
function openFullscreenViewer() {
  if (currentModalImages.length === 0) return;
  const viewer = document.getElementById("fullscreen-viewer");
  const viewerImg = document.getElementById("fullscreen-image");
  const counter = document.getElementById("fullscreen-counter");
  
  if (viewer && viewerImg) {
    viewerImg.src = currentModalImages[currentModalPhotoIndex];
    if (counter) {
      counter.textContent = `${currentModalPhotoIndex + 1} / ${currentModalImages.length}`;
    }
    viewer.style.display = "flex";
    
    // Add escape/arrow keys event listeners to navigate/close viewer
    document.addEventListener("keydown", handleFullscreenKeydown);
  }
}

function closeFullscreenViewer() {
  const viewer = document.getElementById("fullscreen-viewer");
  if (viewer) {
    viewer.style.display = "none";
    document.removeEventListener("keydown", handleFullscreenKeydown);
  }
}

function changeFullscreenPhoto(offset) {
  if (currentModalImages.length <= 1) return;
  currentModalPhotoIndex = (currentModalPhotoIndex + offset + currentModalImages.length) % currentModalImages.length;
  
  // Sync details modal photo
  updateModalPhoto();
  
  // Update fullscreen photo
  const viewerImg = document.getElementById("fullscreen-image");
  const counter = document.getElementById("fullscreen-counter");
  if (viewerImg) {
    viewerImg.src = currentModalImages[currentModalPhotoIndex];
  }
  if (counter) {
    counter.textContent = `${currentModalPhotoIndex + 1} / ${currentModalImages.length}`;
  }
}

function handleFullscreenKeydown(e) {
  if (e.key === "Escape") {
    closeFullscreenViewer();
  } else if (e.key === "ArrowLeft") {
    changeFullscreenPhoto(-1);
  } else if (e.key === "ArrowRight") {
    changeFullscreenPhoto(1);
  }
}

// Track WhatsApp Cliques
function trackWaClick() {
  if (!activeModalPropertyId) return;
  const prop = properties.find(p => p.id === activeModalPropertyId);
  if (prop) {
    prop.waClicks = (prop.waClicks || 0) + 1;
    saveState();
  }
}

// Close modal on overlay click
window.addEventListener("click", (e) => {
  const modal = document.getElementById("property-modal");
  if (e.target === modal) {
    closePropertyModal();
  }
  const loginModal = document.getElementById("login-modal");
  if (e.target === loginModal) {
    closeLoginModal();
  }
});

// Submit Appraisal Request (Client)
function submitAppraisal(event) {
  event.preventDefault();

  const name = document.getElementById("ap-name").value;
  const phone = document.getElementById("ap-phone").value;
  const email = document.getElementById("ap-email").value;
  const type = document.getElementById("ap-type").value;
  const area = document.getElementById("ap-area").value || "Não informado";
  const location = document.getElementById("ap-location").value;
  const details = document.getElementById("ap-details").value || "-";

  const newRequest = {
    id: "req-" + Date.now(),
    name,
    phone,
    email,
    type,
    area,
    location,
    details,
    date: new Date().toLocaleDateString("pt-BR")
  };

  appraisals.push(newRequest);
  saveState();

  const successAlert = document.getElementById("appraisal-success");
  successAlert.style.display = "flex";
  document.getElementById("appraisal-form").reset();

  setTimeout(() => {
    successAlert.style.display = "none";
  }, 6000);
}

// Admin Panel Tab Switcher
function switchAdminTab(tabName, btnElement) {
  const tabs = btnElement.parentElement.querySelectorAll(".admin-tab-btn");
  tabs.forEach(t => t.classList.remove("active"));
  btnElement.classList.add("active");

  const containers = document.querySelectorAll(".admin-container");
  containers.forEach(c => c.classList.remove("active"));

  document.getElementById(`admin-tab-${tabName}`).classList.add("active");
}

// Edit existing property (Loads fields into form)
function editProperty(id) {
  const prop = properties.find(p => p.id === id);
  if (!prop) return;

  editingPropertyId = id;

  // Populate form fields
  document.getElementById("prop-title").value = prop.title;
  document.getElementById("prop-type").value = prop.type;
  document.getElementById("prop-price").value = prop.price;
  document.getElementById("prop-location").value = prop.location;
  document.getElementById("prop-address").value = prop.address || "";
  document.getElementById("prop-area").value = prop.area;
  document.getElementById("prop-beds").value = prop.beds;
  document.getElementById("prop-baths").value = prop.baths;
  document.getElementById("prop-vagas").value = prop.vagas || "";
  document.getElementById("prop-desc").value = prop.desc;

  // Dynamic UI feedback for Edit mode
  document.getElementById("admin-form-title").textContent = "Editar Imóvel";
  document.getElementById("admin-form-submit-btn").textContent = "Salvar Alterações";
  document.getElementById("admin-form-cancel-btn").style.display = "inline-block";

  // Make files input optional during editing
  const fileInput = document.getElementById("prop-files");
  fileInput.required = false;
  document.getElementById("prop-files-star").style.display = "none";
  document.getElementById("prop-files-help").style.display = "block";

  // Smooth scroll to the form card
  const formCard = document.querySelector(".form-card");
  if (formCard) {
    formCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Cancel Edit Mode
function cancelEditProperty() {
  editingPropertyId = null;

  // Reset form
  document.getElementById("new-property-form").reset();

  // Restore dynamic UI elements
  document.getElementById("admin-form-title").textContent = "Cadastrar Novo Imóvel";
  document.getElementById("admin-form-submit-btn").textContent = "Adicionar Imóvel ao Catálogo";
  document.getElementById("admin-form-cancel-btn").style.display = "none";

  // Restore files input required state
  const fileInput = document.getElementById("prop-files");
  fileInput.required = true;
  document.getElementById("prop-files-star").style.display = "inline";
  document.getElementById("prop-files-help").style.display = "none";
}

// Save New Property or Update Existing via Admin Panel (Async reading uploaded files)
async function saveNewProperty(event) {
  event.preventDefault();

  const title = document.getElementById("prop-title").value;
  const status = "venda";
  const type = document.getElementById("prop-type").value;
  const price = parseFloat(document.getElementById("prop-price").value);
  const location = document.getElementById("prop-location").value;
  const address = document.getElementById("prop-address").value;
  const area = parseInt(document.getElementById("prop-area").value);
  const beds = parseInt(document.getElementById("prop-beds").value);
  const baths = parseInt(document.getElementById("prop-baths").value);
  const vagas = parseInt(document.getElementById("prop-vagas").value) || 0;
  const desc = document.getElementById("prop-desc").value;

  const fileInput = document.getElementById("prop-files");
  const files = fileInput.files;
  
  if (editingPropertyId) {
    const idx = properties.findIndex(p => p.id === editingPropertyId);
    if (idx !== -1) {
      const prop = properties[idx];
      let newImages = [];

      if (files && files.length > 0) {
        const readPromises = Array.from(files).map(file => {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(file);
          });
        });
        newImages = await Promise.all(readPromises);
      } else {
        newImages = prop.images;
      }

      properties[idx] = {
        ...prop,
        title,
        status,
        type,
        price,
        location,
        address,
        area,
        beds,
        baths,
        vagas,
        desc,
        image: newImages[0] || prop.image,
        images: newImages
      };

      saveState();
      cancelEditProperty();
      renderFeaturedProperties();
      renderCatalogProperties();
      alert("Imóvel atualizado com sucesso!");
    }
  } else {
    let images = [];
    if (files && files.length > 0) {
      const readPromises = Array.from(files).map(file => {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.readAsDataURL(file);
        });
      });
      images = await Promise.all(readPromises);
    } else {
      images = ["assets/sobrado_real.jpg"];
    }

    const newProperty = {
      id: "prop-" + Date.now(),
      title,
      status,
      type,
      price,
      location,
      address,
      area,
      beds,
      baths,
      vagas,
      views: 0,
      waClicks: 0,
      image: images[0],
      images: images,
      desc
    };

    properties.unshift(newProperty);
    saveState();

    document.getElementById("new-property-form").reset();
    renderFeaturedProperties();
    renderCatalogProperties();

    alert("Imóvel cadastrado com sucesso e adicionado ao catálogo!");
  }
}

// Delete Property via Admin Panel
function deleteProperty(id) {
  if (confirm("Tem certeza de que deseja excluir este imóvel do catálogo?")) {
    properties = properties.filter(p => p.id !== id);
    saveState();
    renderFeaturedProperties();
    renderCatalogProperties();
    updateAdminDashboard();
  }
}

// Delete Appraisal Request via Admin Panel
function deleteAppraisal(id) {
  if (confirm("Tem certeza de que deseja excluir este pedido de avaliação?")) {
    appraisals = appraisals.filter(a => a.id !== id);
    saveState();
  }
}

// Update Admin Dashboard lists & statistics
function updateAdminDashboard() {
  const statTotalProps = document.getElementById("stat-total-props");
  const statTotalEvals = document.getElementById("stat-total-evals");
  const reqCount = document.getElementById("req-count");

  if (statTotalProps) statTotalProps.textContent = properties.length;
  if (statTotalEvals) statTotalEvals.textContent = appraisals.length;
  if (reqCount) reqCount.textContent = appraisals.length;

  const propsBody = document.getElementById("admin-properties-table-body");
  if (propsBody) {
    propsBody.innerHTML = "";
    
    properties.forEach(prop => {
      const tr = document.createElement("tr");
      const safeTitle = escapeHTML(prop.title);
      const safeType = escapeHTML(capitalize(prop.type));
      const safeLocation = escapeHTML(prop.location);
      const safeId = escapeHTML(prop.id);

      tr.innerHTML = `
        <td><strong>${safeTitle}</strong></td>
        <td>${safeType}</td>
        <td>${safeLocation}</td>
        <td><strong>${formatBRL(prop.price)}</strong></td>
        <td style="text-align: center; font-weight: 600; color: var(--primary-color);">${Number(prop.views) || 0}</td>
        <td style="text-align: center; font-weight: 600; color: #25D366;">${Number(prop.waClicks) || 0}</td>
        <td style="text-align: center; white-space: nowrap;">
          <button class="table-action-btn" onclick="editProperty('${safeId}')" title="Editar Imóvel" style="background: var(--primary-color); color: #fff; margin-right: 5px; border-radius: 4px; border: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="table-action-btn btn-delete" onclick="deleteProperty('${safeId}')" title="Excluir Imóvel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
        </td>
      `;
      propsBody.appendChild(tr);
    });
  }

  const reqsBody = document.getElementById("admin-requests-table-body");
  if (reqsBody) {
    reqsBody.innerHTML = "";
    
    if (appraisals.length === 0) {
      reqsBody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-light);">Nenhuma solicitação de avaliação registrada.</td>
        </tr>
      `;
    } else {
      appraisals.forEach(req => {
        const tr = document.createElement("tr");
        const safeName = escapeHTML(req.name);
        const safeDate = escapeHTML(req.date);
        const safePhone = escapeHTML(req.phone);
        const safeEmail = escapeHTML(req.email);
        const safeType = escapeHTML(req.type);
        const safeLocation = escapeHTML(req.location);
        const safeArea = escapeHTML(req.area);
        const safeDetails = escapeHTML(req.details);
        const safeReqId = escapeHTML(req.id);

        tr.innerHTML = `
          <td><strong>${safeName}</strong><br><small style="color: var(--text-light);">${safeDate}</small></td>
          <td>${safePhone}<br><span style="font-size: 0.8rem; color: var(--text-light);">${safeEmail}</span></td>
          <td>${safeType}</td>
          <td>${safeLocation}</td>
          <td>${safeArea} m²</td>
          <td><p style="max-width: 250px; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${safeDetails}">${safeDetails}</p></td>
          <td>
            <button class="table-action-btn btn-delete" onclick="deleteAppraisal('${safeReqId}')" title="Excluir Pedido">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </td>
        `;
        reqsBody.appendChild(tr);
      });
    }
  }
}
