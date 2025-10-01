# METROGUIDE Admin Dashboard

A comprehensive web-based admin dashboard for managing incident reports, vehicle reports, and emergency SOS alerts with real-time tracking and mapping capabilities.

## 🚀 Features

### 📊 **Incident Reports Management**
- Real-time incident report viewing and moderation
- Status management (Pending, Verified, Rejected)
- Advanced filtering and search capabilities
- Proximity clustering for pattern analysis
- Image viewing with modal support

### 🚗 **Vehicle Reports**
- Vehicle incident tracking and management
- Plate number and vehicle type classification
- Location-based reporting
- Status tracking and moderation
- Export functionality (PDF & CSV)

### 🚨 **SOS Emergency Tracking**
- Real-time SOS alert monitoring
- **Interactive Google Maps integration** with location tracking
- Emergency response coordination
- Geographic visualization of emergency calls
- Export and reporting capabilities

### 📈 **Analytics & Reporting**
- Comprehensive PDF export functionality
- CSV data export for analysis
- Historical data management
- User statistics and metrics
- Professional report generation

### 🗺️ **Map Integration**
- Google Maps API integration for SOS location tracking
- Interactive markers with emergency information
- Real-time coordinate display
- Location-based emergency response

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Backend**: Firebase Realtime Database
- **Authentication**: Firebase Auth
- **Functions**: Firebase Cloud Functions
- **Maps**: Google Maps JavaScript API
- **Export**: jsPDF, jsPDF AutoTable
- **Deployment**: Firebase Hosting

## 📦 Project Structure

```
CAPSTONE/
├── home.html          # Main admin dashboard
├── login.html         # Authentication page
├── admin.html         # Admin-specific features
├── module.js          # Core JavaScript functionality
└── metro-guide-...    # Database export/backup

functions/
├── index.js           # Cloud Functions
├── package.json       # Node.js dependencies
└── ...

Configuration Files:
├── firebase.json      # Firebase project config
├── .firebaserc       # Firebase project settings
├── db_rules.json     # Database security rules
└── deploy.ps1        # Deployment script
```

## 🚀 Getting Started

### Prerequisites
- Node.js (v14 or higher)
- Firebase CLI
- Google Maps API key

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd CAPS-BACK-UP
   ```

2. **Install Firebase CLI**
   ```bash
   npm install -g firebase-tools
   ```

3. **Install dependencies**
   ```bash
   cd functions
   npm install
   ```

4. **Configure Firebase**
   ```bash
   firebase login
   firebase use --add
   ```

5. **Set up Google Maps API**
   - Get your API key from Google Cloud Console
   - Update the API key in `home.html`

### 🔧 Configuration

#### Firebase Setup
1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com)
2. Enable Authentication and Realtime Database
3. Update Firebase config in `module.js`

#### Google Maps Setup
1. Enable Maps JavaScript API in Google Cloud Console
2. Replace the API key in `home.html`:
   ```html
   <script async defer src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=geometry"></script>
   ```

### 🚀 Deployment

1. **Build and deploy**
   ```bash
   firebase deploy
   ```

2. **Deploy functions only**
   ```bash
   firebase deploy --only functions
   ```

3. **Deploy hosting only**
   ```bash
   firebase deploy --only hosting
   ```

## 🔐 Security Features

- Firebase Authentication integration
- Role-based access control (Admin/User)
- Database security rules
- Secure API key management
- Input validation and sanitization

## 📱 Responsive Design

- Mobile-friendly interface
- Tablet and desktop optimization
- Touch-friendly controls
- Responsive map integration

## 🎯 Key Functionality

### SOS Map Tracking
- Click the **"View"** button in SOS reports to see emergency locations
- Interactive Google Maps with custom emergency markers
- Real-time coordinate tracking
- Emergency response information display

### Report Management
- Verify or reject incident reports
- Export data in multiple formats
- Advanced filtering and search
- Historical data analysis

### User Management
- View registered users
- Monitor user statistics
- Admin role management

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

This project is developed for educational/institutional use.

## 📞 Support

For support and questions, contact: metroguidenu@gmail.com

---

**METROGUIDE** • Safety & Incident Intelligence Platform