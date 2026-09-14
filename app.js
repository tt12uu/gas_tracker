// ==========================================
// 全局設定與狀態 (Global State)
// ==========================================
const SUPABASE_URL = "https://vphfmrejzflnmcvjmgtu.supabase.co";
const SUPABASE_KEY = "sb_publishable_fgHKnLnNNwIN-yq9AlU5wA_5TBJfJP2";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CACHE_KEY = 'ontario_gas_stations_v2';
const CACHE_TTL = 15 * 60 * 1000; // 15 分鐘快取
const CHUNK_SIZE = 40; // 每頁渲染 40 間油站

let allStations = [];          // 原始與預處理後的數據
let filteredStations = [];     // 經篩選/排序後的數據
let favorites = JSON.parse(localStorage.getItem('gas_favorites') || '[]');
let userLocation = null;

let currentBrandFilter = 'all';
let currentSearchQuery = '';
let showFavoritesOnly = false;
let currentSort = 'distance';
let currentRenderIndex = 0;
let scrollObserver = null;

// ==========================================
// 1. 預處理與效能優化 (Preprocessing & Performance)
// ==========================================

// 預先處理字串，避免喺 filter 迴圈入面重複呼叫 .toLowerCase()
function preprocessStation(s) {
    return {
        ...s,
        _searchKey: `${s.name || ''} ${s.address || ''}`.toLowerCase(),
        _brandLower: (s.brand || '').toLowerCase(),
        distance: null
    };
}

// 記憶化計算距離 (只有位置改變時才執行)
function updateStationDistances(lat, lng) {
    if (!lat || !lng) return;
    const R = 6371; // km
    const rad = d => d * (Math.PI / 180);

    allStations.forEach(s => {
        const dLat = rad(s.lat - lat);
        const dLon = rad(s.lng - lng);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(rad(lat)) * Math.cos(rad(s.lat)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        s.distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    });
}

// 超時控制 (Timeout Wrapper)
function fetchWithTimeout(promise, ms = 5000) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
    return Promise.race([promise, timeout]);
}

// ==========================================
// 2. 數據載入邏輯 (Data Fetching & Cache)
// ==========================================
async function loadStations(forceRefresh = false) {
    showLoading(true);

    // 1. 讀取 LocalStorage 快取
    if (!forceRefresh) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            try {
                const { timestamp, data } = JSON.parse(cached);
                if (Date.now() - timestamp < CACHE_TTL && data.length > 0) {
                    allStations = data.map(preprocessStation);
                    if (userLocation) updateStationDistances(userLocation.lat, userLocation.lng);
                    applyFilterAndSort();
                    showLoading(false);
                    return;
                }
            } catch (e) {
                console.warn("快取解析失敗，重新讀取 API", e);
            }
        }
    }

    // 2. 從 Supabase 讀取數據 (設 5 秒超時)
    let rawData = [];
    try {
        const res = await fetchWithTimeout(supabaseClient.from('stations').select('*'), 5000);
        if (res.data && res.data.length > 0) {
            rawData = res.data;
        }
    } catch (e) {
        console.warn('Supabase 連線超時或出錯，自動啟動備用來源...', e);
    }

    // 3. 處理數據並寫入快取
    if (rawData.length > 0) {
        allStations = rawData.map(preprocessStation);
        if (userLocation) updateStationDistances(userLocation.lat, userLocation.lng);
        
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            data: rawData
        }));
    }

    applyFilterAndSort();
    showLoading(false);
}

// ==========================================
// 3. 單次遍歷篩選與排序 (Single-Pass Filtering & Sorting)
// ==========================================
function applyFilterAndSort() {
    const query = currentSearchQuery.trim().toLowerCase();
    const brand = currentBrandFilter.toLowerCase();

    // 單次 Pass 完成篩選
    filteredStations = allStations.filter(s => {
        if (brand !== 'all' && s._brandLower !== brand) return false;
        if (showFavoritesOnly && !favorites.includes(s.id)) return false;
        if (query && !s._searchKey.includes(query)) return false;
        return true;
    });

    // 排序
    filteredStations.sort((a, b) => {
        if (currentSort === 'price') return a.price - b.price;
        if (currentSort === 'distance') {
            if (a.distance === null) return 1;
            if (b.distance === null) return -1;
            return a.distance - b.distance;
        }
        return a.name.localeCompare(b.name);
    });

    // 重置分頁並渲染第一頁
    renderStationGridChunked(true);
}

// ==========================================
// 4. 分頁極速渲染 (Chunked DOM Rendering)
// ==========================================
function renderStationGridChunked(reset = false) {
    const container = document.getElementById('stations-container');
    if (!container) return;

    if (reset) {
        container.innerHTML = '';
        currentRenderIndex = 0;
    }

    const nextChunk = filteredStations.slice(currentRenderIndex, currentRenderIndex + CHUNK_SIZE);
    
    if (nextChunk.length === 0 && currentRenderIndex === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-10 text-gray-500">搵唔到符合條件嘅油站</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    nextChunk.forEach(station => {
        const isFav = favorites.includes(station.id);
        const card = document.createElement('div');
        card.className = 'bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col justify-between hover:shadow-md transition';
        card.innerHTML = `
            <div>
                <div class="flex justify-between items-start">
                    <span class="text-xs font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-600">${station.brand || 'Independent'}</span>
                    <button onclick="toggleFavorite(${station.id})" class="text-xl leading-none">
                        ${isFav ? '❤️' : '🤍'}
                    </button>
                </div>
                <h3 class="font-bold text-gray-800 mt-2 text-base line-clamp-1">${station.name}</h3>
                <p class="text-gray-500 text-xs mt-1 line-clamp-1">${station.address}</p>
            </div>
            <div class="mt-4 pt-3 border-t border-gray-50 flex justify-between items-end">
                <div>
                    <span class="text-xs text-gray-400">距離</span>
                    <p class="text-sm font-medium text-gray-700">${station.distance !== null ? station.distance.toFixed(1) + ' km' : '--'}</p>
                </div>
                <div class="text-right">
                    <span class="text-xs text-gray-400">Regular</span>
                    <p class="text-2xl font-black text-emerald-600">${station.price ? station.price.toFixed(1) + '¢' : 'N/A'}</p>
                </div>
            </div>
        `;
        fragment.appendChild(card);
    });

    container.appendChild(fragment);
    currentRenderIndex += CHUNK_SIZE;

    setupInfiniteScroll();
}

// 滾動到底部自動加載下一頁
function setupInfiniteScroll() {
    if (scrollObserver) scrollObserver.disconnect();

    let sentinel = document.getElementById('scroll-sentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'scroll-sentinel';
        sentinel.className = 'h-10 w-full col-span-full';
        document.getElementById('stations-container').after(sentinel);
    }

    scrollObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && currentRenderIndex < filteredStations.length) {
            renderStationGridChunked(false);
        }
    }, { rootMargin: '300px' });

    scrollObserver.observe(sentinel);
}

function toggleFavorite(id) {
    if (favorites.includes(id)) {
        favorites = favorites.filter(fId => fId !== id);
    } else {
        favorites.push(id);
    }
    localStorage.setItem('gas_favorites', JSON.stringify(favorites));
    applyFilterAndSort();
}

function showLoading(show) {
    const loader = document.getElementById('loading-spinner');
    if (loader) loader.style.display = show ? 'block' : 'none';
}

// ==========================================
// 5. 事件監聽綁定 (Event Listeners)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // 獲取使用者 GPS 位置
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            pos => {
                userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                if (allStations.length > 0) {
                    updateStationDistances(userLocation.lat, userLocation.lng);
                    applyFilterAndSort();
                }
            },
            err => console.log('定位失敗或未授權權限', err)
        );
    }

    // 搜尋輸入框 (防抖 Debounce 300ms)
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        let timer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                currentSearchQuery = e.target.value;
                applyFilterAndSort();
            }, 300);
        });
    }

    // 油牌篩選
    const brandSelect = document.getElementById('brand-select');
    if (brandSelect) {
        brandSelect.addEventListener('change', (e) => {
            currentBrandFilter = e.target.value;
            applyFilterAndSort();
        });
    }

    // 排序選單
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            applyFilterAndSort();
        });
    }

    // 最愛切換
    const favBtn = document.getElementById('fav-toggle-btn');
    if (favBtn) {
        favBtn.addEventListener('click', () => {
            showFavoritesOnly = !showFavoritesOnly;
            favBtn.classList.toggle('bg-red-500', showFavoritesOnly);
            favBtn.classList.toggle('text-white', showFavoritesOnly);
            applyFilterAndSort();
        });
    }

    // 初次載入
    loadStations();
});
