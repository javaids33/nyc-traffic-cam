# NYC Traffic Cam

This project is a web application that tracks user location and captures images from NYC traffic cameras. It is built using React and TypeScript.

## Project Structure

```
nyc-traffic-cam
├── index.html          # Main entry point for the application
├── src
│   └── location-camera-app.tsx  # React component for location camera application
├── package.json        # npm configuration file
├── tsconfig.json       # TypeScript configuration file
└── README.md           # Project documentation
```

## Setup Instructions

1. **Clone the repository:**
   ```
   git clone https://github.com/yourusername/nyc-traffic-cam.git
   cd nyc-traffic-cam
   ```

2. **Install dependencies:**
   ```
   npm install
   ```

3. **Run the application:**
   ```
   npm start
   ```

   This will start the development server and open the application in your default web browser.

## Usage

- The application will automatically track your location and capture images from the nearest NYC traffic camera when you are within the specified distance threshold.
- You can adjust the trigger distance in the application settings.

## Deployment

To deploy the application on GitHub Pages:

1. Create a new repository on GitHub called `nyc-traffic-cam`.
2. Upload the `index.html` file as the main entry point.
3. Enable GitHub Pages in the repository settings.
4. Access the application via the GitHub Pages URL.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.