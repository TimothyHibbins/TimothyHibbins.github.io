// Project search and column toggle functionality

document.addEventListener('DOMContentLoaded', function () {
    const searchBar = document.getElementById('projectSearch');
    const projectGrid = document.getElementById('projectGrid');
    const columnBtns = document.querySelectorAll('.column-btn');
    const thumbnailItems = document.querySelectorAll('.thumbnail-item');

    // Search functionality
    searchBar.addEventListener('input', function () {
        const searchTerm = this.value.toLowerCase().trim();

        thumbnailItems.forEach(item => {
            const title = item.querySelector('.thumbnail-title').textContent.toLowerCase();
            const description = item.querySelector('.thumbnail-description').textContent.toLowerCase();

            if (title.includes(searchTerm) || description.includes(searchTerm)) {
                item.classList.remove('hidden');
            } else {
                item.classList.add('hidden');
            }
        });
    });

    // Column toggle functionality
    columnBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            const cols = this.getAttribute('data-cols');

            // Update active button
            columnBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            // Update grid classes
            projectGrid.classList.remove('cols-1', 'cols-2', 'cols-3');
            projectGrid.classList.add(`cols-${cols}`);
        });
    });
});
