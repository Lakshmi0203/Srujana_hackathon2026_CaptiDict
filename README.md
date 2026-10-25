# CaptiDict

## Overview

CaptiDict is a web application developed for the Srujana Hackathon. It helps users explore financial activity and cash-flow information through a web interface.

## Features

- User registration and login
- Password hashing and password change
- Authenticated API access using bearer tokens
- Transaction-related functionality
- Cash-flow overview and forecasting
- Profile and settings
- User guide and privacy information

*Update this list to match the features implemented and working in your current version.*

## Technology Stack

### Frontend
- HTML
- CSS
- JavaScript

### Backend
- Node.js
- Express.js
- Prisma ORM
- PostgreSQL
- JSON Web Tokens (JWT)
- bcryptjs for password hashing

## Project Structure

The project contains a frontend and a backend.

- **Frontend:** User interface and browser-side application logic.
- **Backend:** API endpoints, authentication, and application logic.
- **Database:** Stores application data through Prisma and PostgreSQL.

*Add the exact folder and file structure of your repository here.*

## Prerequisites

Install the following before running the project:

- Node.js version 20 or later
- npm
- Docker Desktop, if using Docker to run PostgreSQL
- A PostgreSQL database

## Setup and Run

### 1. Clone the repository

```bash
git clone YOUR_REPOSITORY_URL
cd YOUR_PROJECT_FOLDER
```

Replace the placeholders with your actual repository URL and folder name.

### 2. Configure the backend

Open the backend folder:

```bash
cd backend
npm install
```

Create the required environment configuration using the project's `.env.example` file, if available. Configure the database connection, JWT secret, allowed frontend origins, and other required variables.

**Never commit real passwords, API secrets, or production credentials.**

### 3. Start the database

Start PostgreSQL using the method configured for the project. If using Docker Compose, follow the repository's Compose instructions.

### 4. Prepare the database

Run the Prisma migration command specified by the project's setup instructions. Confirm that the database connection works before starting the backend.

### 5. Start the backend

```bash
npm run dev
```

The current development configuration has been observed to start the API on port `4000`. Confirm the configured port in your environment.

### 6. Start the frontend

Serve the frontend using the method configured in the project. If it calls the backend API, ensure the frontend origin is allowed by the backend's CORS configuration.

## Authentication

The application provides registration and login endpoints under `/api/auth`.

Authenticated endpoints require a bearer token:

```http
Authorization: Bearer YOUR_ACCESS_TOKEN
```

The authentication API includes a user profile endpoint and a password-change endpoint, as implemented in the backend.

## Testing

Verify the following before demonstrating the application:

- A user can register and log in.
- Incorrect login credentials are rejected.
- A logged-in user can access protected endpoints.
- Password changes are saved correctly.
- The old password is rejected after a successful password change.
- Transaction and cash-flow features behave as expected.
- The frontend can communicate with the backend.
- Error messages are handled appropriately.

## Security Notes

- Passwords should be stored as hashes, not plaintext.
- Keep environment files and secrets out of version control.
- Validate input on the backend.
- Protect private endpoints with authentication.
- Use HTTPS and suitable production configuration when deployed.

## Hackathon Submission

- **Project name:** CaptiDict
- **Event:** Srujana Hackathon
- **Repository:** Add your repository URL
- **Demo:** Add your demo URL, if deployed
- **Team members:** Add team member names
- **Documentation:** README, API details, setup instructions, and test results
