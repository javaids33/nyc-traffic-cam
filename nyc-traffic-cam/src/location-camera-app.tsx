import { useState, useEffect, useRef } from 'react';
import {
  Camera,
  MapPin,
  Navigation,
  AlertCircle,
  CheckCircle,
  Wifi,
  WifiOff,
  RefreshCw,
} from 'lucide-react';

// In dev, requests to the NYC TMC API are proxied through Vite to avoid CORS.
const API_URL = '/nyc-graphql';

const FALLBACK_CAMERAS: NycCamera[] = [
  { id: '20503e73-1829-4275-a645-5be6a02fd7cd', lat: 40.7589, lng: -73.9851, isOnline: true },
  { id: 'test-camera-2', lat: 40.7505, lng: -73.9934, isOnline: true },
];

type NycCamera = {
  id: string;
  lat: number;
  lng: number;
  isOnline: boolean;
};

type NearbyCamera = NycCamera & { distance: number };

type UserLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: Date;
};

type CapturedImage = {
  id: number;
  imageBase64: string;
  timestamp: string;
  location: UserLocation | null;
  distance: string;
  cameraName: string;
  cameraId: string;
};

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

const LocationCameraApp = () => {
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [cameras, setCameras] = useState<NycCamera[]>([]);
  const [threshold, setThreshold] = useState<number>(100);
  const [isTracking, setIsTracking] = useState<boolean>(false);
  const [capturedImages, setCapturedImages] = useState<CapturedImage[]>([]);
  const [status, setStatus] = useState<string>('Ready to start tracking');
  const [permissions, setPermissions] = useState<{ location: boolean }>({ location: false });
  const [loadingCameras, setLoadingCameras] = useState<boolean>(false);
  const [nearbyCamera, setNearbyCamera] = useState<NearbyCamera | null>(null);

  // Refs avoid stale-closure bugs inside the geolocation watch callback.
  const camerasRef = useRef<NycCamera[]>([]);
  const thresholdRef = useRef<number>(threshold);
  const lastTriggerRef = useRef<number | null>(null);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    camerasRef.current = cameras;
  }, [cameras]);

  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  const fetchCameras = async () => {
    setLoadingCameras(true);
    setStatus('Loading NYC traffic cameras...');
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `
            query {
              cameras {
                id
                lat: latitude
                lng: longitude
                isOnline
              }
            }
          `,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      if (data.data && data.data.cameras) {
        const onlineCameras: NycCamera[] = data.data.cameras.filter(
          (cam: NycCamera) => cam.isOnline && cam.lat && cam.lng,
        );
        setCameras(onlineCameras);
        setStatus(`Loaded ${onlineCameras.length} online cameras`);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching cameras:', error);
      setStatus(`Failed to load cameras: ${message}. Using fallback cameras.`);
      setCameras(FALLBACK_CAMERAS);
    }
    setLoadingCameras(false);
  };

  const fetchCameraImage = async (
    cameraId: string,
    cameraName: string,
    nearest: NearbyCamera,
    locationAtTrigger: UserLocation,
  ) => {
    try {
      setStatus('Capturing image from traffic camera...');

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `
            query($cameraId: UUID!) {
              camera(cameraId: $cameraId) {
                name
              }
              cameraImage(cameraId: $cameraId)
            }
          `,
          variables: { cameraId },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.errors) {
        console.error('GraphQL errors:', data.errors);
        setStatus('Camera image capture failed');
        return;
      }

      if (data.data && data.data.cameraImage) {
        const distance = calculateDistance(
          locationAtTrigger.latitude,
          locationAtTrigger.longitude,
          nearest.lat,
          nearest.lng,
        ).toFixed(1);

        const newImage: CapturedImage = {
          id: Date.now(),
          imageBase64: data.data.cameraImage,
          timestamp: new Date().toISOString(),
          location: locationAtTrigger,
          distance,
          cameraName: data.data.camera?.name || cameraName,
          cameraId,
        };

        setCapturedImages((prev) => [newImage, ...prev.slice(0, 4)]);
        setStatus(`Image captured from ${newImage.cameraName}! Distance: ${distance}m`);

        setTimeout(() => {
          setStatus('Image sent to user successfully!');
          setTimeout(() => setStatus('Tracking location...'), 2000);
        }, 1000);
      } else {
        setStatus('No image data received from camera');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching camera image:', error);
      setStatus(`Error capturing camera image: ${message}`);
    }
  };

  const findNearestCamera = (location: UserLocation): NearbyCamera | null => {
    const list = camerasRef.current;
    if (!list.length) return null;

    let nearest: NearbyCamera | null = null;
    let minDistance = Infinity;

    list.forEach((camera) => {
      const distance = calculateDistance(location.latitude, location.longitude, camera.lat, camera.lng);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = { ...camera, distance };
      }
    });

    return nearest;
  };

  const handleLocationUpdate = (position: GeolocationPosition) => {
    const newLocation: UserLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: new Date(position.timestamp),
    };

    setUserLocation(newLocation);

    const nearest = findNearestCamera(newLocation);
    setNearbyCamera(nearest);

    if (nearest) {
      const now = Date.now();
      const timeSinceLastTrigger = lastTriggerRef.current ? now - lastTriggerRef.current : Infinity;

      if (nearest.distance <= thresholdRef.current && timeSinceLastTrigger > 30000) {
        lastTriggerRef.current = now;
        fetchCameraImage(nearest.id, `Camera ${nearest.id.substring(0, 8)}...`, nearest, newLocation);
      }

      setStatus(`Tracking... Nearest camera: ${nearest.distance.toFixed(1)}m away`);
    } else {
      setStatus('Tracking... No cameras nearby');
    }
  };

  const startTracking = () => {
    if (!navigator.geolocation) {
      setStatus('Geolocation not supported');
      return;
    }

    if (!cameras.length) {
      setStatus('Please load cameras first');
      return;
    }

    try {
      const id = navigator.geolocation.watchPosition(
        handleLocationUpdate,
        (error) => {
          console.error('Location error:', error);
          setStatus(`Location error: ${error.message}`);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
      );

      watchIdRef.current = id;
      setIsTracking(true);
      setPermissions((prev) => ({ ...prev, location: true }));
      setStatus('Starting location tracking...');
    } catch {
      setStatus('Location access denied');
    }
  };

  const stopTracking = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsTracking(false);
    setNearbyCamera(null);
    setStatus('Tracking stopped');
  };

  useEffect(() => {
    fetchCameras();
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return (
    <div className="max-w-md mx-auto bg-gray-900 text-white min-h-screen">
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 p-4">
        <div className="flex items-center gap-3">
          <Camera className="w-8 h-8" />
          <div>
            <h1 className="text-xl font-bold">NYC Traffic Cam</h1>
            <p className="text-sm opacity-90">Auto-capture when driving past</p>
          </div>
        </div>
      </div>

      <div className="p-4 bg-gray-800">
        <div className="flex items-center gap-3">
          {isTracking ? (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-green-400 text-sm">ACTIVE</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-gray-500 rounded-full"></div>
              <span className="text-gray-400 text-sm">STANDBY</span>
            </div>
          )}
        </div>
        <p className="text-sm mt-2 text-gray-300" data-testid="status">
          {status}
        </p>
      </div>

      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Wifi className="w-5 h-5 text-green-400" />
            <span className="font-semibold">NYC Cameras</span>
          </div>
          <button
            onClick={fetchCameras}
            disabled={loadingCameras}
            className="flex items-center gap-1 px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loadingCameras ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="bg-gray-800 p-3 rounded-lg text-center">
            <div className="text-2xl font-bold text-green-400" data-testid="camera-count">
              {cameras.length}
            </div>
            <div className="text-xs text-gray-400">Online Cameras</div>
          </div>
          <div className="bg-gray-800 p-3 rounded-lg text-center">
            <div className="text-2xl font-bold text-blue-400" data-testid="image-count">
              {capturedImages.length}
            </div>
            <div className="text-xs text-gray-400">Images Captured</div>
          </div>
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1" htmlFor="threshold-input">
            Trigger Distance (meters)
          </label>
          <input
            id="threshold-input"
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value) || 100)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            min={50}
            max={1000}
          />
        </div>
      </div>

      {userLocation && (
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2 mb-2">
            <MapPin className="w-5 h-5 text-blue-400" />
            <span className="font-semibold">Current Location</span>
          </div>
          <div className="text-sm text-gray-300">
            <p>Lat: {userLocation.latitude.toFixed(6)}</p>
            <p>Lng: {userLocation.longitude.toFixed(6)}</p>
            <p>Accuracy: ±{userLocation.accuracy.toFixed(0)}m</p>
          </div>
        </div>
      )}

      {nearbyCamera && (
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2 mb-2">
            <Camera className="w-5 h-5 text-green-400" />
            <span className="font-semibold">Nearest Camera</span>
          </div>
          <div className="text-sm text-gray-300">
            <p>ID: {nearbyCamera.id.substring(0, 13)}...</p>
            <p>Distance: {nearbyCamera.distance.toFixed(1)}m</p>
            <p>Lat: {nearbyCamera.lat.toFixed(6)}</p>
            <p>Lng: {nearbyCamera.lng.toFixed(6)}</p>
            {nearbyCamera.distance <= threshold && (
              <div className="mt-2 px-2 py-1 bg-green-600 rounded text-xs font-semibold">
                IN RANGE - Ready to capture!
              </div>
            )}
          </div>
        </div>
      )}

      <div className="p-4">
        {!isTracking ? (
          <button
            onClick={startTracking}
            disabled={!cameras.length}
            className="w-full bg-green-600 hover:bg-green-700 text-white py-3 px-6 rounded-lg font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Navigation className="w-5 h-5" />
            Start Tracking
          </button>
        ) : (
          <button
            onClick={stopTracking}
            className="w-full bg-red-600 hover:bg-red-700 text-white py-3 px-6 rounded-lg font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            <AlertCircle className="w-5 h-5" />
            Stop Tracking
          </button>
        )}
      </div>

      {capturedImages.length > 0 && (
        <div className="p-4 border-t border-gray-800">
          <h3 className="font-semibold mb-3">Recent Traffic Cam Images</h3>
          <div className="space-y-3">
            {capturedImages.map((image) => (
              <div key={image.id} className="bg-gray-800 rounded-lg overflow-hidden">
                <img
                  src={image.imageBase64}
                  alt={`Traffic camera ${image.cameraName}`}
                  className="w-full h-48 object-contain bg-black"
                />
                <div className="p-3">
                  <div className="text-sm font-medium text-white mb-1">{image.cameraName}</div>
                  <div className="text-xs text-gray-400 space-y-1">
                    <p>{new Date(image.timestamp).toLocaleString()}</p>
                    <p>Distance: {image.distance}m</p>
                    <p>{image.cameraId.substring(0, 13)}...</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 border-t border-gray-800 text-xs">
        <div className="flex items-center justify-between mb-1">
          <span>Location Permission:</span>
          <span
            className={`flex items-center gap-1 ${
              permissions.location ? 'text-green-400' : 'text-gray-400'
            }`}
          >
            {permissions.location ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            {permissions.location ? 'Granted' : 'Pending'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>NYC API Status:</span>
          <span
            className={`flex items-center gap-1 ${
              cameras.length > 0 ? 'text-green-400' : 'text-gray-400'
            }`}
          >
            {cameras.length > 0 ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            {cameras.length > 0 ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <div className="p-4 text-xs text-gray-500 text-center border-t border-gray-800">
        <p>Data from NYC Department of Transportation</p>
        <p>Traffic cameras update in real-time</p>
      </div>
    </div>
  );
};

export default LocationCameraApp;
