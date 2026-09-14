// 載入資料時進行一次性 Preprocessing
function preprocessStationData(rawStations) {
    return rawStations.map(station => ({
        ...station,
        brandLower: (station.brand || '').toLowerCase(),
        // 預先拼接搜尋字串，避免每次搜尋時動態創建新字串
        searchKey: `${station.name} ${station.address} ${station.brand}`.toLowerCase()
    }));
}

// 快取搜尋條件並執行高效 Filter / Sort
let lastQuery = '', cachedQueryLower = '';
let lastBrand = 'all', cachedBrandLower = 'all';

function getFilteredAndSortedStations(stations, query, brand, sortMode) {
    // 只有當 Filter 內容改變時才執行 toLowerCase()
    if (query !== lastQuery) {
        lastQuery = query;
        cachedQueryLower = query.trim().toLowerCase();
    }
    if (brand !== lastBrand) {
        lastBrand = brand;
        cachedBrandLower = brand.toLowerCase();
    }

    // 1. 單次遍歷篩選
    const filtered = stations.filter(s => {
        const matchBrand = cachedBrandLower === 'all' || s.brandLower === cachedBrandLower;
        const matchSearch = !cachedQueryLower || s.searchKey.includes(cachedQueryLower);
        return matchBrand && matchSearch;
    });

    // 2. 距離排序：預先拆分有距離與無距離兩組，消除 sort 迴圈內的 null 檢查
    if (sortMode === 'distance') {
        const validDist = [];
        const nullDist = [];
        for (let i = 0; i < filtered.length; i++) {
            if (filtered[i].distance !== null) validDist.push(filtered[i]);
            else nullDist.push(filtered[i]);
        }
        validDist.sort((a, b) => a.distance - b.distance);
        return validDist.concat(nullDist);
    }
    
    if (sortMode === 'price') return filtered.sort((a, b) => a.price - b.price);
    if (sortMode === 'name') return filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered;
}
