// ==========================================
// 1. STATE & GLOBAL SINGLETONS
// ==========================================
let supabaseClient = null;
const SUPABASE_URL = 'https://vphfmrejzflnmcvjmgtu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fgHKnLnNNwIN-yq9AlU5wA_5TBJfJP2';

if (SUPABASE_URL.includes('YOUR_PROJECT_ID') === false && typeof supabase !== 'undefined') {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// User Location & Stations Data
let userLocation = { lat: 43.876, lng: -79.438 }; // Richmond Hill Default
let rawStations = [];       
let filteredStations = [];  

// UI & Render States
const CHUNK_SIZE = 15;
let currentRenderedIndex = 0;
let globalScrollObserver = null;
let favWriteTimer = null;

// Filter Caches (Memoization)
let currentSearchQuery = '';
let cachedQueryLower = '';
let currentBrandFilter = 'all';
let cachedBrandLower = 'all';
let currentSort = 'distance';
let showFavoritesOnly = false;

// Favorites set initialized from LocalStorage
let favorites = new Set(JSON.parse(localStorage.getItem('gta_gas_favorites')) || []);

// ==========================================
// 2. INITIALIZATION & EVENT LISTENERS
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadOntarioStations(userLocation.lat, userLocation.lng);
});

function setupEventListeners() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentSearchQuery = e.target.value;
            cachedQueryLower = currentSearchQuery.trim().toLowerCase();
            applyFiltersAndRender();
        });
    }

    const brandSelect = document.getElementById('brand-select');
    if (brandSelect) {
        brandSelect.addEventListener('change', (e) => {
            currentBrandFilter = e.target.value;
            cachedBrandLower = currentBrandFilter.toLowerCase();
            applyFiltersAndRender();
        });
    }

    const favBtn = document.getElementById('fav-toggle-btn');
    if (favBtn) {
        favBtn.addEventListener('click', () => {
            showFavoritesOnly = !showFavoritesOnly;
            favBtn.classList.toggle('bg-amber-500', showFavoritesOnly);
            favBtn.classList.toggle('text-white', showFavoritesOnly);
            applyFiltersAndRender();
        });
    }

    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            applyFiltersAndRender();
        });
    }
}

// ==========================================
// 3. HAVERSINE & PREPROCESSING
// ==========================================
function haversineDistance(coords1, coords2) {
    if (!coords1 || !coords2 || coords1.lat == null || coords2.lat == null) return null;
    const toRad = x => (x * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(coords2.lat - coords1.lat);
    const dLon = toRad(coords2.lng - coords1.lng);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(coords1.lat)) * Math.cos(toRad(coords2.lat)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(1));
}

function preprocessStations(data, userLat, userLng) {
    return data.map((item, index) => {
        const brand = item.brand || item.tags?.brand || item.tags?.name || 'Independent';
        const normalizedBrand = normalizeBrand(brand);
        const name = item.name || item.tags?.name || `${normalizedBrand} Gas Station`;
        const address = item.address || `${item.tags?.['addr:street'] || 'Ontario Regional Rd'}, ${item.tags?.['addr:city'] || 'Ontario'}`;
        const lat = parseFloat(item.lat || item.coordinates?.lat);
        const lng = parseFloat(item.lng || item.coordinates?.lng);
        const dist = haversineDistance({ lat: userLat, lng: userLng }, { lat, lng });

        return {
            id: item.id || index + 1000,
            brand: normalizedBrand,
            brandLower: normalizedBrand.toLowerCase(),
            name: name,
            address: address,
            price: parseFloat(item.price) || 185.9,
            updated: item.updated || 'Live',
            coordinates: { lat, lng },
            distance: dist,
            _searchKey: `${name} ${address} ${normalizedBrand}`.toLowerCase()
        };
    });
}

function normalizeBrand(rawBrand) {
    const b = rawBrand.toLowerCase();
    if (b.includes('shell')) return 'Shell';
    if (b.includes('petro')) return 'Petro-Canada';
    if (b.includes('esso')) return 'Esso';
    if (b.includes('costco')) return 'Costco';
    if (b.includes('pioneer')) return 'Pioneer';
    return rawBrand.length > 20 ? 'Independent' : rawBrand;
}

// ==========================================
// 4. DATA FETCHING (SUPABASE / OSM FALLBACK)
// ==========================================
async function loadOntarioStations(lat, lng) {
    const spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.classList.remove('hidden');

    let fetchedData = [];

    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient.from('stations').select('*');
            if (!error && data && data.length >= 10) {
                fetchedData = data;
            }
        } catch (e) {
            console.error('Supabase fetch failed, falling back to OSM:', e);
        }
    }

    if (fetchedData.length === 0) {
        try {
            const ontarioBBox = '42.0,-83.5,46.5,-74.5';
            const overpassQuery = `[out:json][timeout:25];node["amenity"="fuel"](${ontarioBBox});out 1000;`;
            const response = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`);
            const json = await response.json();
            fetchedData = json.elements || [];
        } catch (err) {
            console.error('OSM fetch failed:', err);
        }
    }

    rawStations = preprocessStations(fetchedData, lat, lng);
    if (spinner) spinner.classList.add('hidden');
    applyFiltersAndRender();
}

// ==========================================
// 5. FILTERING, OPTIMIZED SORTING & RENDERING
// ==========================================
function applyFiltersAndRender() {
    filteredStations = rawStations.filter(s => {
        const matchesBrand = cachedBrandLower === 'all' || s.brandLower === cachedBrandLower;
        const matchesSearch = !cachedQueryLower || s._searchKey.includes(cachedQueryLower);
        const matchesFav = !showFavoritesOnly || favorites.has(s.id);
        return matchesBrand && matchesSearch && matchesFav;
    });

    if (currentSort === 'distance') {
        const validDist = [];
        const nullDist = [];
        for (let i = 0; i < filteredStations.length; i++) {
            if (filteredStations[i].distance !== null) validDist.push(filteredStations[i]);
            else nullDist.push(filteredStations[i]);
        }
        validDist.sort((a, b) => a.distance - b.distance);
        filteredStations = validDist.concat(nullDist);
    } else if (currentSort === 'price') {
        filteredStations.sort((a, b) => a.price - b.price);
    } else if (currentSort === 'name') {
        filteredStations.sort((a, b) => a.name.localeCompare(b.name));
    }

    currentRenderedIndex = 0;
    const container = document.getElementById('stations-container');
    if (container) container.innerHTML = '';

    renderNextChunk();
}

function renderNextChunk() {
    const container = document.getElementById('stations-container');
    if (!container) return;

    const chunk = filteredStations.slice(currentRenderedIndex, currentRenderedIndex + CHUNK_SIZE);
    if (chunk.length === 0 && currentRenderedIndex === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400">No stations match your search.</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    chunk.forEach(station => {
        const card = createStationCardElement(station);
        fragment.appendChild(card);
    });
    container.appendChild(fragment);

    currentRenderedIndex += chunk.length;

    let sentinel = document.getElementById('scroll-sentinel');
    if (currentRenderedIndex < filteredStations.length) {
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'scroll-sentinel';
            sentinel.className = 'h-10 w-full col-span-full flex items-center justify-center';
            container.after(sentinel);
        }
        attachGlobalObserver(sentinel);
    } else {
        if (sentinel) sentinel.remove();
        if (globalScrollObserver) globalScrollObserver.disconnect();
    }
}

// ==========================================
// 6. SINGLETON OBSERVER & DOM UTILS
// ==========================================
function attachGlobalObserver(sentinelElement) {
    if (!globalScrollObserver) {
        globalScrollObserver = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                renderNextChunk();
            }
        }, { rootMargin: '300px' });
    } else {
        globalScrollObserver.disconnect();
    }
    globalScrollObserver.observe(sentinelElement);
}

function createStationCardElement(station) {
    const card = document.createElement('div');
    const isFav = favorites.has(station.id);
    card.className = `bg-white dark:bg-slate-900 rounded-2xl p-5 border ${isFav ? 'border-amber-400 ring-1 ring-amber-400/30' : 'border-slate-200 dark:border-slate-800'} shadow-sm flex flex-col justify-between space-y-4`;

    const mapUrl = `https://www.google.com/maps?q=${station.coordinates.lat},${station.coordinates.lng}`;

    card.innerHTML = `
        <div class="flex items-start justify-between">
            <div>
                <span class="px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    ${station.brand}
                </span>
                <h3 class="font-bold text-base mt-2 leading-tight dark:text-white">${station.name}</h3>
                <p class="text-xs text-slate-500 mt-1">${station.address}</p>
            </div>
            <div class="flex flex-col items-end space-y-2">
                <button onclick="toggleFavorite(${station.id})" class="p-1.5 rounded-lg text-lg ${isFav ? 'text-amber-400' : 'text-slate-300 dark:text-slate-600'}">
                    ★
                </button>
                <div class="text-2xl font-black text-slate-900 dark:text-white">
                    ${station.price}<span class="text-xs font-normal text-slate-500">¢/L</span>
                </div>
            </div>
        </div>
        <div class="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
            <span>${station.distance !== null ? station.distance + ' km away' : 'Distance N/A'}</span>
            <a href="${mapUrl}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 bg-blue-500/10 text-blue-600 rounded-lg font-semibold">
                Maps
            </a>
        </div>
    `;
    return card;
}

window.toggleFavorite = function(id) {
    if (favorites.has(id)) {
        favorites.delete(id);
    } else {
        favorites.add(id);
    }

    applyFiltersAndRender();

    clearTimeout(favWriteTimer);
    favWriteTimer = setTimeout(() => {
        localStorage.setItem('gta_gas_favorites', JSON.stringify([...favorites]));
    }, 400);
};
