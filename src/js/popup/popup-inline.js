if (window.top) {
    window.top.postMessage({ type: 'popup-bootstrap' }, '*');
} else {
    window.postMessage({ type: 'popup-bootstrap' }, '*');
}

const popupScript = document.createElement('script');
popupScript.setAttribute('type', 'text/javascript');
popupScript.setAttribute('src', './js/popup.9243839bedd3458f3892.js');
popupScript.setAttribute('async', 'false');
document.body.appendChild(popupScript);
