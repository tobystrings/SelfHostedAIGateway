export function aerialImageUrl(latitude: number, longitude: number, radius: number) {
  const latitudeDelta = Math.min(radius, 1_500) / 111_320;
  const longitudeDelta = latitudeDelta / Math.cos(latitude * Math.PI / 180);
  const bbox = [longitude - longitudeDelta, latitude - latitudeDelta, longitude + longitudeDelta, latitude + latitudeDelta].join(',');
  return `https://imagery.oregonexplorer.info/arcgis/rest/services/OSIP_2024/OSIP_2024_WM/ImageServer/exportImage?${new URLSearchParams({ bbox, bboxSR: '4326', imageSR: '4326', size: '1024,1024', format: 'png', f: 'image' })}`;
}

export function terrainImageUrl(latitude: number, longitude: number, radius: number) {
  const latitudeDelta = Math.min(radius, 1_500) / 111_320;
  const longitudeDelta = latitudeDelta / Math.cos(latitude * Math.PI / 180);
  const bbox = [longitude - longitudeDelta, latitude - latitudeDelta, longitude + longitudeDelta, latitude + latitudeDelta].join(',');
  return `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?${new URLSearchParams({ bbox, bboxSR: '4326', imageSR: '4326', size: '1024,1024', format: 'png', f: 'image' })}`;
}
