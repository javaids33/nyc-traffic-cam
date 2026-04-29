@echo off
echo Starting Ollama Serve...
start "Ollama" cmd /c "ollama serve"

echo Starting the React UI...
start "React UI" cmd /k "npm run dev"

echo Starting Python POI Classification...
IF EXIST .\.venv\Scripts\python.exe (
    start "POI Classification" cmd /k ".\.venv\Scripts\python -m server.poi_classify_local --resume"
) ELSE (
    start "POI Classification" cmd /k "python -m server.poi_classify_local --resume"
)

echo All services have been launched in separate windows!
