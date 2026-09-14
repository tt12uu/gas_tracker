import requests
from supabase import create_client, Client
import random

# Supabase 設定
SUPABASE_URL = "https://vphfmrejzflnmcvjmgtu.supabase.co"
SUPABASE_KEY = "sb_publishable_fgHKnLnNNwIN-yq9AlU5wA_5TBJfJP2"  # 若啟用了 RLS，請替換為 service_role key
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def sync_stations():
    print("🚀 開始從 OpenStreetMap 抓取全安省油站...")
    
    # 1. 向 Overpass API 請求安省 Bounding Box 內的油站 (上限 1,200 間)
    overpass_url = "https://overpass-api.de/api/interpreter"
    query = '[out:json][timeout:30];node["amenity"="fuel"](42.0,-83.5,46.5,-74.5);out 1200;'
    
    try:
        res = requests.post(overpass_url, data={'data': query}, timeout=35).json()
        elements = res.get('elements', [])
        print(f"🌐 成功取得 {len(elements)} 間油站數據！")
    except Exception as e:
        print(f"❌ 抓取 OpenStreetMap 數據失敗: {e}")
        return

    current_osm_ids = [item['id'] for item in elements]
    stations_to_upsert = []

    # 2. 整理數據結構
    for index, item in enumerate(elements):
        tags = item.get('tags', {})
        brand = tags.get('brand', tags.get('name', 'Independent'))
        street = tags.get('addr:street', 'Ontario Rd')
        housenumber = tags.get('addr:housenumber', '')
        city = tags.get('addr:city', 'Ontario')
        
        address_str = f"{housenumber} {street}, {city}".strip()
        
        # 模擬油價 (Costco 較便宜，其他品牌微幅波動)
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

    # 3. 分批寫入 Supabase (每次 200 筆，避免 Request 超時)
    batch_size = 200
    for i in range(0, len(stations_to_upsert), batch_size):
        batch = stations_to_upsert[i:i + batch_size]
        supabase.table("stations").upsert(batch).execute()
        print(f"已寫入/更新第 {i+1} 至 {i+len(batch)} 筆資料...")

    # 4. 刪除已結業/從 OSM 移除的油站
    try:
        db_response = supabase.table("stations").select("id").execute()
        db_ids = [row['id'] for row in db_response.data]
        
        closed_ids = list(set(db_ids) - set(current_osm_ids))
        if closed_ids:
            # 分批刪除
            for i in range(0, len(closed_ids), batch_size):
                supabase.table("stations").delete().in_("id", closed_ids[i:i + batch_size]).execute()
            print(f"🗑️ 已從資料庫成功清理 {len(closed_ids)} 間已結業油站。")
    except Exception as e:
        print(f"⚠️ 清理舊資料時出現提示: {e}")

    print("✅ 全安省油站同步成功完成！")

if __name__ == "__main__":
    sync_stations()
