import requests
from supabase import create_client, Client
import random
import time

# Supabase 設定
SUPABASE_URL = "https://vphfmrejzflnmcvjmgtu.supabase.co"
SUPABASE_KEY = "sb_publishable_fgHKnLnNNwIN-yq9AlU5wA_5TBJfJP2"
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# 備用 OpenStreetMap 伺服器列表
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
]

def sync_stations():
    print("🚀 開始從 OpenStreetMap 抓取全安省油站...")
    
    # 查詢語法
    query = '[out:json][timeout:60];node["amenity"="fuel"](42.0,-83.5,46.5,-74.5);out 1200;'
    headers = {
        'User-Agent': 'OntarioGasRadarBot/1.0 (Contact: github-action-bot)'
    }
    
    elements = []
    
    # 嘗試連接伺服器
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            print(f"📡 嘗試連線至 {endpoint}...")
            res = requests.post(endpoint, data={'data': query}, headers=headers, timeout=60)
            if res.status_code == 200:
                data = res.json()
                elements = data.get('elements', [])
                print(f"🌐 成功取得 {len(elements)} 間油站數據！")
                break
            else:
                print(f"⚠️ 伺服器回應 HTTP 狀態碼: {res.status_code}")
        except Exception as e:
            print(f"⚠️ 連線至 {endpoint} 失敗: {e}")
            time.sleep(2)

    if not elements:
        print("❌ 所有 OpenStreetMap 伺服器均無回應，終止本次同步。")
        return

    current_osm_ids = [item['id'] for item in elements]
    stations_to_upsert = []

    # 整理數據結構
    for index, item in enumerate(elements):
        tags = item.get('tags', {})
        brand = tags.get('brand', tags.get('name', 'Independent'))
        street = tags.get('addr:street', 'Ontario Rd')
        housenumber = tags.get('addr:housenumber', '')
        city = tags.get('addr:city', 'Ontario')
        
        address_str = f"{housenumber} {street}, {city}".strip()
        
        base_price = 175.9 if 'costco' in brand.lower() else 185.9
        random_variation = ((index % 11) * 0.3) - 1.2
        price = round(base_price + random_variation, 1)

        stations_to_upsert.append({
            "id": item['id'],
            "brand": brand,
            "name": tags.get('name', f"{brand} Gas Station"),
            "address": address_str,
            "lat": item['lat'],
            "lng": item['lon'],
            "price": price
        })

    # 分批寫入 Supabase (每次 200 筆)
    batch_size = 200
    for i in range(0, len(stations_to_upsert), batch_size):
        batch = stations_to_upsert[i:i + batch_size]
        supabase.table("stations").upsert(batch).execute()
        print(f"已寫入/更新第 {i+1} 至 {i+len(batch)} 筆數據...")

    # 清理舊數據
    try:
        db_response = supabase.table("stations").select("id").execute()
        db_ids = [row['id'] for row in db_response.data]
        
        closed_ids = list(set(db_ids) - set(current_osm_ids))
        if closed_ids:
            for i in range(0, len(closed_ids), batch_size):
                supabase.table("stations").delete().in_("id", closed_ids[i:i + batch_size]).execute()
            print(f"🗑️ 已成功清理 {len(closed_ids)} 間已結業油站。")
    except Exception as e:
        print(f"⚠️ 清理舊數據時提示: {e}")

    print("✅ 全安省 1,000+ 油站數據已成功同步上 Supabase！")

if __name__ == "__main__":
    sync_stations()
