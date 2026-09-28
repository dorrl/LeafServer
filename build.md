before building
```powershell
npx expo prebuild
cd android```

debug (convert to .apk)
```powershell
./gradlew assembleDebug```
release (convert to .aab)
```powershell
./gradlew assembleRelease```